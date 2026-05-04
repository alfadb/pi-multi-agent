/**
 * runner.ts — SDK-based single-task executor.
 *
 * Replaces the old print/rpc subprocess backends. Every task = one in-process
 * `completeSimple` call, optionally wrapped in a tool-calling loop when the
 * task requested tools. Bounded by THREE independent limits:
 *   1. per-task timeout (linked to parent abort signal so ESC wins instantly)
 *   2. parent ctx.signal propagating from the host pi
 *   3. MAX_TOOL_TURNS hard cap on the tool-calling loop — protects against
 *      prompt-injected files looping the model through unbounded tool calls
 *      to burn the timeout budget on tokens. 50 turns is generous for legit
 *      multi-step research while still stopping pathological cases fast.
 */

import { completeSimple } from "@mariozechner/pi-ai";
import type { AssistantMessage, Context, Message, ToolCall } from "@mariozechner/pi-ai";
import type { ResolvedModel, Task, TaskResult } from "./types.js";
import { buildSubagentTools, rejectionMessage } from "./subagent-tools.js";

/** Maximum tool-calling iterations before forced termination. Real research
 *  tasks rarely exceed 10-20 turns; 50 is a generous safety cap. */
const MAX_TOOL_TURNS = 50;

/** Standard "model not resolvable" TaskResult — used by every strategy when
 *  resolveModels couldn't produce a ResolvedModel for a task (invalid ref,
 *  unknown provider, or auth fail). Centralized so error shape is consistent
 *  across parallel/debate/chain/ensemble. */
export function missingModelResult(task: Task): TaskResult {
  return {
    taskId: task.id,
    model: task.model,
    role: task.role,
    output: "",
    error: `Model not found: ${task.model}`,
    durationMs: 0,
  };
}

export interface RunnerCtx {
  /** Project cwd — passed to subagent tools (read/edit/etc. and imagine output dir). */
  cwd: string;
  /** Model registry (shared with parent pi) — needed by vision tool. */
  modelRegistry: any;
  /** Vision preference list from config. */
  visionPrefs: string[];
  /** Per-task timeout in ms. */
  taskTimeoutMs: number;
  /** Parent abort signal (from extension ctx). Honored end-to-end. */
  signal?: AbortSignal;
}

function extractText(msg: AssistantMessage): string {
  return msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map(c => c.text)
    .join("\n")
    .trim();
}

function extractToolCalls(msg: AssistantMessage): ToolCall[] {
  return msg.content.filter((c): c is ToolCall => c.type === "toolCall");
}

function totalUsage(u: AssistantMessage["usage"]): TaskResult["usage"] | undefined {
  if (!u) return undefined;
  return {
    input: u.input ?? 0,
    output: u.output ?? 0,
    total: u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0),
  };
}

export async function runTask(
  task: Task,
  resolved: ResolvedModel,
  rctx: RunnerCtx,
): Promise<TaskResult> {
  const start = Date.now();
  const modelId = `${resolved.provider}/${resolved.modelId}`;

  // Per-task abort: linked to parent signal so ESC propagates immediately.
  // CRITICAL: if parent signal is *already* aborted before runTask is called
  // (e.g. caller pre-cancelled, or this is a follow-up task in a sequential
  // strategy where ESC fired during a prior task), the addEventListener path
  // never fires — abort events don't replay. Without this sync check, the task
  // would proceed to call completeSimple and run to its own timeout (verified:
  // 57s wall on a pre-aborted signal). Sync-propagate first.
  const ac = new AbortController();
  if (rctx.signal?.aborted) ac.abort();
  const onParentAbort = () => ac.abort();
  rctx.signal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), rctx.taskTimeoutMs);
  // Don't keep the event loop alive solely for this timer; abort behavior is
  // unchanged because completeSimple's pending fetch keeps the loop alive
  // until the request settles, and ac.signal works either way.
  timer.unref?.();

  try {
    // Validate + build tools first; reject with structured error before LLM call.
    const built = await buildSubagentTools(task.tools, {
      cwd: rctx.cwd,
      modelRegistry: rctx.modelRegistry,
      taskModel: resolved.model,
      visionPrefs: rctx.visionPrefs,
    });
    if (built.rejected.length > 0) {
      return {
        taskId: task.id,
        model: modelId,
        role: task.role,
        output: "",
        error: rejectionMessage(built.rejected),
        durationMs: Date.now() - start,
      };
    }

    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: task.prompt }],
        timestamp: Date.now(),
      },
    ];

    let lastUsage: TaskResult["usage"];
    let turn = 0;

    // Tool-calling loop. Single-shot tasks (no tools) terminate after iter 1.
    while (true) {
      turn += 1;
      if (turn > MAX_TOOL_TURNS) {
        return {
          taskId: task.id,
          model: modelId,
          role: task.role,
          output: "",
          error: `Tool-calling loop exceeded MAX_TOOL_TURNS=${MAX_TOOL_TURNS}. The model kept emitting tool calls without converging on a final answer; possible prompt injection or runaway loop.`,
          durationMs: Date.now() - start,
          usage: lastUsage,
        };
      }
      const ctx: Context = {
        systemPrompt: "",
        messages,
        ...(built.tools.length > 0 ? { tools: built.tools as any } : {}),
      };

      let msg: AssistantMessage;
      try {
        msg = await completeSimple(resolved.model, ctx, {
          apiKey: resolved.apiKey,
          headers: resolved.headers,
          signal: ac.signal,
          ...(task.thinking !== "off" ? { reasoning: task.thinking } : {}),
        } as any);
      } catch (e: any) {
        return {
          taskId: task.id,
          model: modelId,
          role: task.role,
          output: "",
          error: e?.message ?? String(e),
          durationMs: Date.now() - start,
          usage: lastUsage,
        };
      }

      if (msg.usage) lastUsage = totalUsage(msg.usage);
      messages.push(msg);

      // Terminal stop reasons (other than "stop"): bail with whatever text we have.
      if (msg.stopReason === "error" || msg.stopReason === "aborted" || msg.stopReason === "length") {
        return {
          taskId: task.id,
          model: modelId,
          role: task.role,
          output: extractText(msg),
          error: msg.errorMessage ?? msg.stopReason,
          durationMs: Date.now() - start,
          usage: lastUsage,
        };
      }

      const toolCalls = extractToolCalls(msg);
      if (toolCalls.length === 0) {
        // stopReason==="stop" with no tools → terminal success.
        return {
          taskId: task.id,
          model: modelId,
          role: task.role,
          output: extractText(msg),
          durationMs: Date.now() - start,
          usage: lastUsage,
        };
      }

      // Dispatch every tool call in this turn (sequential — the agent picks
      // its own concurrency by emitting multiple calls; we don't fan them
      // further). Append a toolResult per call in original order.
      //
      // SDK tool contract: errors are signalled by throw, NOT by an isError
      // field on the result. We catch the throw and set isError=true on the
      // toolResult message; some of our subagent-tools also include isError on
      // their AgentToolResult (typed as `any`) for cross-compat with extension
      // tools — we honor it if present.
      for (const call of toolCalls) {
        const tool = built.tools.find(t => t.name === call.name);
        let resultContent: any[];
        let isError = false;
        if (!tool) {
          resultContent = [{ type: "text", text: `unknown tool: ${call.name}` }];
          isError = true;
        } else {
          try {
            const r: any = await tool.execute(call.id, call.arguments ?? {}, ac.signal);
            resultContent = r.content;
            isError = !!r.isError;
          } catch (e: any) {
            resultContent = [
              { type: "text", text: `tool '${call.name}' threw: ${e?.message ?? String(e)}` },
            ];
            isError = true;
          }
        }
        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: resultContent,
          isError,
          timestamp: Date.now(),
        } as Message);
      }
      // Loop continues.
    }
  } catch (e: any) {
    return {
      taskId: task.id,
      model: modelId,
      role: task.role,
      output: "",
      error: e?.message ?? String(e),
      durationMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
    rctx.signal?.removeEventListener("abort", onParentAbort);
  }
}
