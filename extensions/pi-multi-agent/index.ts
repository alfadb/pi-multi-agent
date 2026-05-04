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
  TaskResult,
} from "./types.js";
import { loadConfig, DEFAULT_CONFIG } from "./config.js";
import { executeParallel } from "./strategies/parallel.js";
import { executeDebate } from "./strategies/debate.js";
import { executeChain } from "./strategies/chain.js";
import { executeEnsemble } from "./strategies/ensemble.js";
import type { RunnerCtx } from "./runner.js";
import { analyzeImage } from "./tools/vision-core.js";
import { generateImage } from "./tools/imagine-core.js";

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
        'Aliases: "readonly" (=read,grep,find,ls), "coding" (=read+bash+edit+write+grep+find+ls). ' +
        "Multi-agent: vision, imagine. Anything else (incl. multi_dispatch) is rejected.",
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

  for (const task of tasks) {
    await resolveOne(task.id, task.model);
  }
  if (synthesisModel) {
    await resolveOne("__synthesis__", synthesisModel);
  }

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

    if (task.error) {
      lines.push(`**Error:** ${task.error}`);
    } else {
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
      "Subagent tool access: omit `tools` for pure reasoning. Use 'readonly' (read,grep,find,ls) for code review. Use 'coding' for tasks that must edit files. Add 'vision' or 'imagine' explicitly when needed.",
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

      const resolvedModels = await resolveModels(
        typedTasks,
        ctx.modelRegistry,
        opts.synthesisModel,
      );

      const rctx: RunnerCtx = {
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
        visionPrefs: config.visionModelPreferences,
        taskTimeoutMs: opts.taskTimeoutMs ?? DEFAULT_CONFIG.taskTimeoutMs,
        signal: _signal,
      };

      const result = await dispatch(
        strategy as Strategy,
        typedTasks,
        opts,
        resolvedModels,
        rctx,
      );

      if (ctx.hasUI) {
        try {
          const ok = result.tasks.filter((t) => !t.error).length;
          const fail = result.tasks.filter((t) => t.error).length;
          ctx.ui.setStatus("multi-agent", `🤖 ${ok}/${tasks.length} done`);
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
