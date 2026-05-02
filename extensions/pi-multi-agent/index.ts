/**
 * pi-multi-agent — Multi-model parallel agent dispatch for pi coding agent.
 *
 * Registers the `multi_dispatch` tool, enabling the LLM to spawn parallel,
 * debate, chain, or ensemble sub-agent tasks across different models and backends.
 *
 * Usage in skills/prompts:
 *   multi_dispatch(strategy="parallel", tasks=[...], options={...})
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type {
  Task,
  Strategy,
  DispatchOptions,
  DispatchResult,
  ResolvedModel,
} from "./types.js";
import { loadConfig, DEFAULT_CONFIG } from "./config.js";
import { executeParallel } from "./strategies/parallel.js";
import { executeDebate } from "./strategies/debate.js";
import { executeChain } from "./strategies/chain.js";
import { executeEnsemble } from "./strategies/ensemble.js";
import { cleanupRpcSessions } from "./backends/rpc.js";
import { executeTmux, isTmuxAvailable } from "./backends/tmux.js";

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
    Type.String({ description: "Comma-separated tool allowlist" }),
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
  executionMode: Type.Optional(
    Type.String({ description: "Override execution mode: print, rpc, tmux, sdk" }),
  ),
  taskTimeoutMs: Type.Optional(
    Type.Number({ description: "Per-task timeout in ms (default 300000)" }),
  ),
});

// ── Model resolution ─────────────────────────────────────────────

async function resolveModels(
  tasks: Task[],
  registry: any,
): Promise<Map<string, ResolvedModel>> {
  const resolved = new Map<string, ResolvedModel>();

  for (const task of tasks) {
    const [provider, modelId] = task.model.split("/");
    if (!provider || !modelId) {
      console.error(`[pi-multi-agent] Invalid model ref: ${task.model}`);
      continue;
    }

    const model = registry.find(provider, modelId);
    if (!model) {
      console.error(`[pi-multi-agent] Model not found: ${task.model}`);
      continue;
    }

    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      console.error(
        `[pi-multi-agent] Auth failed for ${task.model}: ${auth.error ?? "no key"}`,
      );
      continue;
    }

    resolved.set(task.id, {
      provider,
      modelId,
      apiKey: auth.apiKey,
      headers: auth.headers ?? {},
      baseUrl: model.baseUrl,
    });
  }

  return resolved;
}

// ── Mode resolution ─────────────────────────────────────────────

async function resolveMode(
  explicitMode: ExecutionMode | undefined,
  strategy: Strategy,
): Promise<ExecutionMode> {
  // If user explicitly requested a mode, use it
  if (explicitMode) {
    if (explicitMode === "tmux" && !(await isTmuxAvailable())) {
      console.log("[pi-multi-agent] tmux not available, falling back to print");
      return "print";
    }
    return explicitMode;
  }
  // Default: use strategy's default mode
  return DEFAULT_CONFIG.strategyModes[strategy];
}


// ── Strategy dispatch ────────────────────────────────────────────

async function dispatch(
  strategy: Strategy,
  tasks: Task[],
  opts: DispatchOptions,
  resolvedModels: Map<string, ResolvedModel>,
  extraFlags: string[],
): Promise<DispatchResult> {
  const timeoutMs = opts.taskTimeoutMs ?? DEFAULT_CONFIG.taskTimeoutMs;
  const config = { ...opts, timeoutMs, extraFlags };

  const start = Date.now();

  // Resolve actual execution mode: explicit override > tmux if available > default
  const effectiveMode = await resolveMode(opts.executionMode, strategy);
  const dispatchOpts = { ...config, executionMode: effectiveMode };

  switch (strategy) {
    case "parallel": {
      let taskResults: TaskResult[];
      if (effectiveMode === "tmux") {
        taskResults = await executeTmux(tasks, resolvedModels, {
          taskTimeoutMs: config.timeoutMs,
          extraFlags: config.extraFlags,
        });
      } else {
        taskResults = await executeParallel(tasks, resolvedModels, dispatchOpts);
      }
      return {
        strategy,
        executionMode: effectiveMode,
        tasks: taskResults,
        totalDurationMs: Date.now() - start,
      };
    }

    case "debate": {
      if (effectiveMode === "tmux") {
        console.log("[pi-multi-agent] tmux not supported for debate, falling back to rpc");
      }
      const debateMode = effectiveMode === "tmux" ? "rpc" : effectiveMode;
      const debateOpts = { ...dispatchOpts, executionMode: debateMode };
      const { taskResults: dr, synthesis: ds } = await executeDebate(
        tasks,
        resolvedModels,
        debateOpts,
      );
      return {
        strategy,
        executionMode: debateMode,
        tasks: dr,
        synthesis: ds,
        totalDurationMs: Date.now() - start,
      };
    }

    case "chain": {
      let taskResults: TaskResult[];
      if (effectiveMode === "tmux") {
        // Chain steps visible in separate tmux windows
        // Build per-step prompts with accumulated context
        const roundsPerTask = new Map<string, string[]>();
        let prevOutput = "";
        for (const task of tasks) {
          const chainPrompt = prevOutput
            ? `${task.prompt}\n\n---\n## Previous step output\n${prevOutput}`
            : task.prompt;
          roundsPerTask.set(task.id, [chainPrompt]);
          prevOutput = "(see next round)";
        }
        taskResults = await executeTmux(tasks, resolvedModels, {
          taskTimeoutMs: config.timeoutMs,
          extraFlags: config.extraFlags,
        }, roundsPerTask);
      } else {
        taskResults = await executeChain(tasks, resolvedModels, dispatchOpts);
      }
      return {
        strategy,
        executionMode: effectiveMode,
        tasks: taskResults,
        totalDurationMs: Date.now() - start,
      };
    }

    case "ensemble": {
      if (effectiveMode === "tmux") {
        console.log("[pi-multi-agent] tmux not supported for ensemble, falling back to print");
      }
      const ensMode = effectiveMode === "tmux" ? "print" : effectiveMode;
      const ensOpts = { ...dispatchOpts, executionMode: ensMode };
      const { taskResults: er, synthesis: es } = await executeEnsemble(
        tasks,
        resolvedModels,
        ensOpts,
      );
      return {
        strategy,
        executionMode: ensMode,
        tasks: er,
        synthesis: es,
        totalDurationMs: Date.now() - start,
      };
    }

    default:
      return {
        strategy,
        executionMode: "print",
        tasks: [],
        error: `Unknown strategy: ${strategy}`,
        totalDurationMs: 0,
      };
  }
}

// ── Format result for LLM consumption ────────────────────────────

function formatResult(result: DispatchResult): string {
  const lines: string[] = [
    `# Multi-Agent Dispatch Result`,
    `Strategy: ${result.strategy} | Mode: ${result.executionMode} | Duration: ${(result.totalDurationMs / 1000).toFixed(1)}s`,
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

    if (task.error) {
      lines.push(`**Error:** ${task.error}`);
    } else {
      // Truncate very long outputs for the LLM context
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
  // Cleanup RPC sessions on shutdown
  pi.on("session_shutdown", () => {
    cleanupRpcSessions();
  });

  pi.registerTool({
    name: "multi_dispatch",
    label: "Multi-Agent Dispatch",
    description:
      "Execute multiple AI tasks in parallel, debate, chain, or ensemble mode. " +
      "Each task can use a different model and thinking level. " +
      "Backends: print (headless), rpc (multi-turn), tmux (visible panes). " +
      "Use for: parallel code review, multi-expert design debate, chain coding, ensemble decision-making.",
    promptSnippet:
      "multi_dispatch(strategy, tasks[], options?) — spawn parallel sub-agents with different models",
    promptGuidelines: [
      "Use multi_dispatch for tasks that benefit from multiple models/perspectives: code review, design discussion, critical decisions.",
      "Choose strategy: parallel for independent analysis, debate for collaborative discussion, chain for sequential refinement, ensemble for independent votes + synthesis.",
      "Assign different models per task based on strengths: Claude for security, GPT for architecture, DeepSeek for performance.",
      "Set thinking level per task: xhigh for critical analysis, off for simple lookups.",
      "The tool runs asynchronously and returns merged results. Check task error fields for failures.",
    ],
    parameters: Type.Object({
      strategy: StrategySchema,
      tasks: Type.Array(TaskSchema, {
        description: "Array of tasks to dispatch",
      }),
      options: Type.Optional(DispatchOptionsSchema),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { strategy, tasks, options } = params;

      // Validate
      if (!["parallel", "debate", "chain", "ensemble"].includes(strategy)) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid strategy: ${strategy}. Use: parallel, debate, chain, ensemble.`,
            },
          ],
          isError: true,
        };
      }

      if (!tasks || tasks.length === 0) {
        return {
          content: [{ type: "text", text: "No tasks provided." }],
          isError: true,
        };
      }

      // Load config
      const config = loadConfig(ctx.cwd);
      const opts: DispatchOptions = {
        debateRounds: options?.debateRounds ?? config.debateRounds,
        synthesisModel: options?.synthesisModel,
        synthesisThinking: (options?.synthesisThinking as DispatchOptions["synthesisThinking"]) ?? config.synthesisThinking,
        executionMode: (options?.executionMode as DispatchOptions["executionMode"]) ?? config.strategyModes[strategy as Strategy],
        taskTimeoutMs: options?.taskTimeoutMs ?? config.taskTimeoutMs,
      };

      // Update status
      if (ctx.hasUI) {
        try {
          ctx.ui.setStatus(
            "multi-agent",
            `⏳ dispatching ${tasks.length} tasks [${strategy}]...`,
          );
        } catch {}
      }

      // Resolve models
      const resolvedModels = await resolveModels(tasks, ctx.modelRegistry);

      // Dispatch
      const result = await dispatch(
        strategy as Strategy,
        tasks,
        opts,
        resolvedModels,
        config.extraPiFlags,
      );

      // Update status
      if (ctx.hasUI) {
        try {
          const ok = result.tasks.filter((t) => !t.error).length;
          const fail = result.tasks.filter((t) => t.error).length;
          ctx.ui.setStatus("multi-agent", `✓ ${ok} done${fail ? `, ${fail} failed` : ""}`);
          ctx.ui.notify(
            `multi-agent: ${ok}/${tasks.length} tasks completed [${strategy}]`,
            fail > 0 ? "warning" : "info",
          );
        } catch {}
      }

      return {
        content: [{ type: "text", text: formatResult(result) }],
        details: { result },
      };
    },
  });
}
