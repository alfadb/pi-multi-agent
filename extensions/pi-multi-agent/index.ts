/**
 * pi-multi-agent — multi-model parallel agent dispatch for the pi coding agent.
 *
 * Registers three tools:
 *   - multi_dispatch: spawn parallel/debate/chain/ensemble subagents (SDK-only)
 *   - vision:        delegate image analysis to the best vision-capable model
 *   - imagine:       generate an image via OpenAI gpt-image-2 / dall-e
 *
 * Architecture: SDK-only. Every subagent task is one in-process completeSimple
 * call (with optional tool-calling loop). No subprocess, no cwd pollution, no
 * orphan processes; ESC propagates through ctx.signal end-to-end.
 *
 * Subagents may delegate to vision/imagine via Task.tools (those run as
 * AgentTool instances built on the same core functions used here). They cannot
 * delegate to multi_dispatch itself (no nested dispatch) or to arbitrary
 * third-party extension tools (no ExtensionContext forwarding).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type {
  DispatchOptions,
  DispatchResult,
  ResolvedModel,
  Strategy,
  Task,
} from "./types.js";
import { loadConfig, DEFAULT_CONFIG } from "./config.js";

/** Hard upper bound on tasks per dispatch. Each task is an independent LLM
 *  call, so unbounded `tasks.length` becomes a rate-limit storm + cost
 *  explosion vector if the model is prompt-injected. 16 is generous for any
 *  reasonable parallel/ensemble use; debate/chain rarely needs > 5. */
const MAX_TASKS_PER_DISPATCH = 16;
import { executeParallel } from "./strategies/parallel.js";
import { executeDebate } from "./strategies/debate.js";
import { executeChain } from "./strategies/chain.js";
import { executeEnsemble } from "./strategies/ensemble.js";
import type { RunnerCtx } from "./runner.js";
import { analyzeImage } from "./tools/vision-core.js";
import { generateImage } from "./tools/imagine-core.js";
import { logEvent, clip } from "./logger.js";
import * as crypto from "node:crypto";

// ── Tool schema ──────────────────────────────────────────────────

const TaskSchema = Type.Object({
  id: Type.String({ description: "Unique task identifier" }),
  model: Type.String({ description: 'Provider/model e.g. "openai/gpt-5.5"' }),
  thinking: Type.String({
    description: "Thinking level: off, minimal, low, medium, high, xhigh",
  }),
  prompt: Type.String({ description: "Prompt sent to this task" }),
  role: Type.Optional(Type.String({ description: "Human-readable role label" })),
  tools: Type.Optional(
    Type.String({
      description:
        "Comma-separated tool allowlist. Built-ins: read, bash, edit, write, grep, find, ls. " +
        'Alias: "readonly" (=read,grep,find,ls). ' +
        "Multi-agent: vision, imagine. Mutating built-ins (bash/edit/write) require " +
        "PI_MULTI_AGENT_ALLOW_MUTATING=1. Anything else (incl. multi_dispatch) is rejected.",
    }),
  ),
});

const StrategySchema = Type.String({
  description: "Execution strategy: parallel, debate, chain, ensemble",
});

const DispatchOptionsSchema = Type.Object({
  debateRounds: Type.Optional(
    Type.Number({ description: "Number of debate rounds (debate only, default 2)" }),
  ),
  synthesisModel: Type.Optional(
    Type.String({ description: "Model for final synthesis (debate/ensemble)" }),
  ),
  synthesisThinking: Type.Optional(
    Type.String({ description: "Thinking level for synthesis" }),
  ),
  taskTimeoutMs: Type.Optional(
    Type.Number({ description: "Per-task timeout in ms (default 300000)" }),
  ),
});

// ── Model resolution ─────────────────────────────────────────────

/**
 * Resolve every task's "provider/modelId" string into a ResolvedModel
 * (concrete Model<Api> object + apiKey + headers). Tasks whose model can't
 * be resolved are simply omitted from the map; runTask reports them as
 * "Model not found" errors.
 *
 * Also resolves the synthesis model (if specified separately), keyed under
 * "__synthesis__" so debate/ensemble can pick it up.
 */
async function resolveModels(
  tasks: Task[],
  registry: any,
  synthesisModel?: string,
): Promise<Map<string, ResolvedModel>> {
  const resolved = new Map<string, ResolvedModel>();

  const resolveOne = async (id: string, modelStr: string) => {
    const [provider, modelId] = modelStr.split("/");
    if (!provider || !modelId) {
      console.error(`[pi-multi-agent] Invalid model ref: ${modelStr}`);
      return;
    }
    const model = registry.find(provider, modelId);
    if (!model) {
      console.error(`[pi-multi-agent] Model not found: ${modelStr}`);
      return;
    }
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      console.error(
        `[pi-multi-agent] Auth failed for ${modelStr}: ${auth.error ?? "no key"}`,
      );
      return;
    }
    resolved.set(id, {
      provider,
      modelId,
      model,
      apiKey: auth.apiKey,
      headers: auth.headers ?? {},
      baseUrl: model.baseUrl,
    });
  };

  // Resolve in parallel — each resolveOne does a registry lookup + auth call,
  // and there's no inter-task dependency. Serial resolution wastes wall time
  // proportional to the number of tasks (each auth call is ~ms-class).
  const jobs: Promise<void>[] = tasks.map((t) => resolveOne(t.id, t.model));
  if (synthesisModel) jobs.push(resolveOne("__synthesis__", synthesisModel));
  await Promise.all(jobs);

  return resolved;
}

// ── Strategy dispatch ────────────────────────────────────────────

async function dispatch(
  strategy: Strategy,
  tasks: Task[],
  opts: DispatchOptions,
  resolvedModels: Map<string, ResolvedModel>,
  rctx: RunnerCtx,
): Promise<DispatchResult> {
  const start = Date.now();
  if (tasks.length === 0) {
    return { strategy, tasks: [], error: "No tasks provided", totalDurationMs: 0 };
  }
  try {
    switch (strategy) {
      case "parallel": {
        const t = await executeParallel(tasks, resolvedModels, rctx, opts);
        return { strategy, tasks: t, totalDurationMs: Date.now() - start };
      }
      case "debate": {
        const { taskResults, synthesis } = await executeDebate(
          tasks, resolvedModels, rctx, opts,
        );
        return { strategy, tasks: taskResults, synthesis, totalDurationMs: Date.now() - start };
      }
      case "chain": {
        const t = await executeChain(tasks, resolvedModels, rctx, opts);
        return { strategy, tasks: t, totalDurationMs: Date.now() - start };
      }
      case "ensemble": {
        const { taskResults, synthesis } = await executeEnsemble(
          tasks, resolvedModels, rctx, opts,
        );
        return { strategy, tasks: taskResults, synthesis, totalDurationMs: Date.now() - start };
      }
      default:
        return {
          strategy,
          tasks: [],
          error: `Unknown strategy: ${strategy}`,
          totalDurationMs: 0,
        };
    }
  } catch (e: any) {
    return {
      strategy,
      tasks: [],
      error: `Dispatch failed: ${e?.message ?? String(e)}`,
      totalDurationMs: Date.now() - start,
    };
  }
}

// ── Format result for LLM consumption ────────────────────────────

function formatResult(result: DispatchResult): string {
  const lines: string[] = [
    `# Multi-Agent Dispatch Result`,
    `Strategy: ${result.strategy} | Duration: ${(result.totalDurationMs / 1000).toFixed(1)}s`,
    "",
  ];

  if (result.error) {
    lines.push(`**Error:** ${result.error}`);
    return lines.join("\n");
  }

  lines.push(`## Tasks (${result.tasks.length})`);
  lines.push("");

  for (const task of result.tasks) {
    const role = task.role ? ` (${task.role})` : "";
    const dur = (task.durationMs / 1000).toFixed(1);
    lines.push(`### ${task.taskId}${role} — ${task.model} [${dur}s]`);

    // Error and partial output coexist in two real cases:
    //   1. debate strategy aggregates rounds — earlier rounds may have
    //      produced text before a later round errored.
    //   2. tool-loop tasks may emit partial text before the loop hits a
    //      stopReason of error/length/aborted (runner returns both).
    // Showing only the error in those cases hides the actual model output
    // the user paid tokens for. Surface both.
    if (task.error) {
      lines.push(`**Error:** ${task.error}`);
    }
    if (task.output) {
      const output = task.output.length > 8000
        ? task.output.slice(0, 8000) + "\n\n[...truncated...]"
        : task.output;
      lines.push(output);
    }
    lines.push("");
  }

  if (result.synthesis) {
    lines.push("## Synthesis");
    lines.push("");
    lines.push(result.synthesis);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Extension entry ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Persistent status bar icon
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      try { ctx.ui.setStatus("multi-agent", "🤖 multi-agent"); } catch {}
    }
  });

  pi.registerTool({
    name: "multi_dispatch",
    label: "Multi-Agent Dispatch",
    description:
      "Execute multiple AI tasks in parallel, debate, chain, or ensemble mode. " +
      "Each task can use a different model and thinking level. " +
      "All tasks run in-process (SDK-only) — no subprocess, no orphan risk. " +
      "Subagents may use SDK built-in tools or vision/imagine via the `tools` field. " +
      "Use for: parallel code review, multi-expert design debate, chain coding, ensemble decision-making.",
    promptSnippet:
      "multi_dispatch(strategy, tasks[], options?) — spawn in-process sub-agents with different models",
    promptGuidelines: [
      "Use multi_dispatch for tasks that benefit from multiple models/perspectives: code review, design discussion, critical decisions.",
      "Choose strategy: parallel for independent analysis, debate for collaborative discussion, chain for sequential refinement, ensemble for independent votes + synthesis.",
      "Assign different models per task based on strengths: Claude for security, GPT for architecture, DeepSeek for performance.",
      "Set thinking level per task: xhigh for critical analysis, off for simple lookups.",
      "Subagent tool access: omit `tools` for pure reasoning. Use 'readonly' (read,grep,find,ls) for code review. To edit files, list 'read,edit,write' explicitly AND set PI_MULTI_AGENT_ALLOW_MUTATING=1 in env (no 'coding' alias — naming would imply safety it can't deliver). Add 'vision' or 'imagine' explicitly when needed.",
      "The tool runs asynchronously and returns merged results. Check task error fields for failures.",
    ],
    parameters: Type.Object({
      strategy: StrategySchema,
      // Some pi runtimes (notably the sub2api anthropic tool-calling path)
      // arrive at the schema validator with `tasks` already JSON-stringified
      // — the upstream provider serialized the tool input as a single string
      // and pi's validator then sees `string ≠ array` and rejects before
      // execute() is reached. Accept either shape here; the execute body
      // detects and parses the string variant. The TaskSchema array remains
      // the canonical / LLM-facing form.
      tasks: Type.Union(
        [
          Type.Array(TaskSchema, { maxItems: MAX_TASKS_PER_DISPATCH }),
          Type.String({
            description:
              "Stringified JSON array of tasks (compat path — prefer the array form). " +
              "This branch exists only for upstream providers that flatten tool inputs.",
          }),
        ],
        {
          description: `Array of tasks to dispatch (max ${MAX_TASKS_PER_DISPATCH}). Prefer raw JSON array; stringified JSON also accepted.`,
        },
      ),
      options: Type.Optional(DispatchOptionsSchema),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { strategy, options } = params;
      let tasks: any = params.tasks;

      // Compat-unwrap: when an upstream provider stringified the tasks
      // array, decode it before validation. This restores the original
      // shape so the rest of execute() doesn't have to branch.
      // Bounded log so a malformed string doesn't poison the dispatch.log
      // line length (logger already truncates, but earlier visibility is
      // useful when triaging schema-vs-payload bugs).
      if (typeof tasks === "string") {
        try {
          const parsed = JSON.parse(tasks);
          if (Array.isArray(parsed)) {
            logEvent(ctx.cwd, "dispatch:compat_unwrap", {
              strategy,
              fromType: "string",
              tasksDecoded: parsed.length,
              preview: clip(tasks, 80),
            });
            tasks = parsed;
          } else {
            return {
              content: [{
                type: "text",
                text: `Invalid tasks payload: stringified JSON did not decode to an array (got ${typeof parsed}).`,
              }],
              details: { error: "tasks string did not decode to array" },
              isError: true,
            };
          }
        } catch (e: any) {
          return {
            content: [{
              type: "text",
              text: `Invalid tasks payload: tasks was a string but JSON.parse failed: ${e?.message ?? String(e)}`,
            }],
            details: { error: "tasks string parse failed" },
            isError: true,
          };
        }
      }

      if (!["parallel", "debate", "chain", "ensemble"].includes(strategy)) {
        return {
          content: [{
            type: "text",
            text: `Invalid strategy: ${strategy}. Use: parallel, debate, chain, ensemble.`,
          }],
          details: { error: `invalid strategy: ${strategy}` },
          isError: true,
        };
      }
      if (!tasks || tasks.length === 0) {
        return {
          content: [{ type: "text", text: "No tasks provided." }],
          details: { error: "empty tasks" },
          isError: true,
        };
      }
      // Defense-in-depth: schema maxItems should already reject this, but the
      // schema layer is JSON-Schema-only and some providers may not enforce
      // it. Belt-and-suspenders runtime check.
      if (tasks.length > MAX_TASKS_PER_DISPATCH) {
        return {
          content: [{
            type: "text",
            text: `Too many tasks: ${tasks.length} (max ${MAX_TASKS_PER_DISPATCH}). Split into multiple dispatches if you genuinely need this many.`,
          }],
          details: { error: "too many tasks" },
          isError: true,
        };
      }

      const config = loadConfig(ctx.cwd);
      const opts: DispatchOptions = {
        debateRounds: options?.debateRounds ?? config.debateRounds,
        synthesisModel: options?.synthesisModel,
        synthesisThinking:
          (options?.synthesisThinking as DispatchOptions["synthesisThinking"]) ??
          config.synthesisThinking,
        taskTimeoutMs: options?.taskTimeoutMs ?? config.taskTimeoutMs,
      };

      if (ctx.hasUI) {
        try {
          ctx.ui.setStatus(
            "multi-agent",
            `🤖 dispatching ${tasks.length} tasks [${strategy}]...`,
          );
        } catch {}
      }

      // typebox emits `thinking: string` from the Type.String schema; the
      // ThinkingLevel union is enforced at runtime by pi-ai, so cast here.
      const typedTasks = tasks as Task[];

      // Short correlation id so dispatch.log lines can be tied to the
      // dispatch that produced them. 8 hex = 4 bytes; collision-free for
      // any plausible per-cwd dispatch volume.
      const dispatchId = crypto.randomBytes(4).toString("hex");
      const dispatchStart = Date.now();

      logEvent(ctx.cwd, "dispatch:start", {
        dispatch: dispatchId,
        strategy,
        tasks: typedTasks.length,
        models: typedTasks.map(t => t.model).join(","),
        ids: typedTasks.map(t => t.id).join(","),
        synthesisModel: opts.synthesisModel ?? "-",
        debateRounds: opts.debateRounds,
        taskTimeoutMs: opts.taskTimeoutMs,
      });

      const resolvedModels = await resolveModels(
        typedTasks,
        ctx.modelRegistry,
        opts.synthesisModel,
      );

      // Surface unresolved models early — otherwise they only show as
      // "Model not found" errors in per-task results, which is invisible
      // to anyone tailing dispatch.log without context.
      const unresolved = typedTasks
        .filter(t => !resolvedModels.has(t.id))
        .map(t => `${t.id}=${t.model}`);
      if (opts.synthesisModel && !resolvedModels.has("__synthesis__")) {
        unresolved.push(`synthesis=${opts.synthesisModel}`);
      }
      if (unresolved.length > 0) {
        logEvent(ctx.cwd, "dispatch:resolve_failed", {
          dispatch: dispatchId,
          unresolved: unresolved.join(","),
        });
      }

      const rctx: RunnerCtx = {
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
        visionPrefs: config.visionModelPreferences,
        taskTimeoutMs: opts.taskTimeoutMs ?? DEFAULT_CONFIG.taskTimeoutMs,
        signal: _signal,
        dispatchId,
        strategy: strategy as string,
      };

      const result = await dispatch(
        strategy as Strategy,
        typedTasks,
        opts,
        resolvedModels,
        rctx,
      );

      // Aggregate token usage across tasks (best-effort — some providers
      // omit usage on streaming errors).
      let totalIn = 0, totalOut = 0;
      for (const t of result.tasks) {
        if (t.usage) {
          totalIn += t.usage.input ?? 0;
          totalOut += t.usage.output ?? 0;
        }
      }
      const okCount = result.tasks.filter((t) => !t.error).length;
      const failCount = result.tasks.filter((t) => t.error).length;
      logEvent(ctx.cwd, "dispatch:end", {
        dispatch: dispatchId,
        strategy,
        ok: okCount,
        fail: failCount,
        totalIn,
        totalOut,
        durationMs: Date.now() - dispatchStart,
        synthesis: result.synthesis ? "yes" : "no",
      });

      if (ctx.hasUI) {
        try {
          ctx.ui.setStatus("multi-agent", `🤖 ${okCount}/${tasks.length} done`);
          ctx.ui.notify(
            `multi-agent: ${okCount}/${tasks.length} tasks completed [${strategy}]`,
            failCount > 0 ? "warning" : "info",
          );
        } catch {}
      }

      return {
        content: [{ type: "text", text: formatResult(result) }],
        details: { result },
      };
    },
  });

  // ── imagine — AI image generation via DALL-E / gpt-image-2 ───

  pi.registerTool({
    name: "imagine",
    label: "AI Image Generation",
    description:
      "Generate images using DALL-E 3. Call when the user asks to create, generate, " +
      "or draw an image. Supports size (1024x1024, 1792x1024, 1024x1792), quality " +
      "(standard, hd), and style (vivid, natural).",
    promptSnippet: "Generate image: imagine(prompt, size?, quality?)",
    promptGuidelines: [
      "Use imagine when the user asks for image generation, illustration, or visual creation.",
      "Generate images using OpenAI's latest model (gpt-image-2). Default quality is hd, default size is 1024x1024.",
      "The tool returns a base64 image the LLM can display directly.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Image description/prompt" }),
      model: Type.Optional(Type.String({ description: "Image model: gpt-image-2 (default, latest), dall-e-3, dall-e-2" })),
      size: Type.Optional(Type.String({ description: "1024x1024, 1792x1024, or 1024x1792" })),
      quality: Type.Optional(Type.String({ description: "standard or hd (default)" })),
      style: Type.Optional(Type.String({ description: "vivid or natural (via prompt, not API param)" })),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const callerSupportsImages = !!(ctx.model as any)?.input?.includes?.("image");
      const r = await generateImage(params, {
        cwd: ctx.cwd,
        callerSupportsImages,
        signal: _signal,
      });
      if (r.ok === false) {
        return { content: [{ type: "text", text: r.error }], details: { error: r.error }, isError: true };
      }
      const text =
        `✅ Image saved: ${r.filepath} (${r.actualSize ?? r.requestedSize ?? "default"}, ` +
        `quality=${r.actualQuality ?? r.requestedQuality ?? "default"})`;
      const content: any[] = [{ type: "text", text }];
      if (r.imageBase64 && r.mimeType) {
        content.push({ type: "image", data: r.imageBase64, mimeType: r.mimeType });
      }
      return {
        content,
        details: {
          model: r.model,
          requestedSize: r.requestedSize,
          actualSize: r.actualSize,
          requestedQuality: r.requestedQuality,
          actualQuality: r.actualQuality,
          path: r.filepath,
        },
      };
    },
  });

  // ── vision — auto-delegate image analysis to best vision model ─

  pi.registerTool({
    name: "vision",
    label: "Vision Delegate",
    description:
      "Analyze images using the best available vision model. Use when the current model " +
      "does not support image input, or when you want a dedicated vision model for image analysis. " +
      "Automatically selects the strongest available vision-capable model.",
    promptSnippet: "Analyze image: vision(imageBase64, prompt)",
    promptGuidelines: [
      "Use vision when the user provides an image (screenshot, photo, diagram) and the current model cannot process images.",
      "Auto-selects from available vision-capable models per .pi-multi-agent/config.json visionModelPreferences (built-in defaults cover OpenAI/Anthropic/Google).",
      "Returns the text analysis from the vision model.",
    ],
    parameters: Type.Object({
      imageBase64: Type.Optional(Type.String({ description: "Base64 encoded image data" })),
      path: Type.Optional(Type.String({ description: "Path to image file (alternative to imageBase64)" })),
      mimeType: Type.Optional(Type.String({ description: "Image MIME type, e.g. image/png" })),
      prompt: Type.String({ description: "What to analyze/look for in the image" }),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd || process.cwd());
      const r = await analyzeImage(params, {
        modelRegistry: ctx.modelRegistry,
        prefs: cfg.visionModelPreferences ?? [],
        // If the main model supports images we shouldn't be calling vision —
        // exclude it as a candidate so we always pick a *different* model.
        excludeMain: ctx.model,
        signal: _signal,
        // Path-based image loads are confined to ctx.cwd — prevents an
        // LLM-supplied path from exfiltrating files outside the project tree.
        cwd: ctx.cwd,
      });
      if (r.ok === false) {
        return { content: [{ type: "text", text: r.error }], details: { error: r.error }, isError: true };
      }
      return {
        content: [{ type: "text", text: `## Vision Analysis (${r.model})\n\n${r.text}` }],
        details: { model: r.model, usage: r.usage, candidates: r.candidates },
      };
    },
  });
}
