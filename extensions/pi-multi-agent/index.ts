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
    Type.String({ description: "Override execution mode: print, rpc, sdk" }),
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

  // Validate tasks
  if (tasks.length === 0) {
    return { strategy, executionMode: "print", tasks: [], error: "No tasks provided", totalDurationMs: 0 };
  }

  // Validate and resolve execution mode
  const VALID_MODES = ["print", "rpc"];
  let effectiveMode = opts.executionMode ?? DEFAULT_CONFIG.strategyModes[strategy];
  if (!VALID_MODES.includes(effectiveMode)) {
    effectiveMode = DEFAULT_CONFIG.strategyModes[strategy];
  }
  const dispatchOpts = { ...config, executionMode: effectiveMode };

  try {
    switch (strategy) {
      case "parallel": {
        const taskResults = await executeParallel(tasks, resolvedModels, dispatchOpts);
        return { strategy, executionMode: effectiveMode, tasks: taskResults, totalDurationMs: Date.now() - start };
      }
      case "debate": {
        const { taskResults, synthesis } = await executeDebate(tasks, resolvedModels, dispatchOpts);
        return { strategy, executionMode: effectiveMode, tasks: taskResults, synthesis, totalDurationMs: Date.now() - start };
      }
      case "chain": {
        const taskResults = await executeChain(tasks, resolvedModels, dispatchOpts);
        return { strategy, executionMode: effectiveMode, tasks: taskResults, totalDurationMs: Date.now() - start };
      }
      case "ensemble": {
        const { taskResults, synthesis } = await executeEnsemble(tasks, resolvedModels, dispatchOpts);
        return { strategy, executionMode: effectiveMode, tasks: taskResults, synthesis, totalDurationMs: Date.now() - start };
      }
      default:
        return { strategy, executionMode: "print", tasks: [], error: `Unknown strategy: ${strategy}`, totalDurationMs: 0 };
    }
  } catch (e: any) {
    return { strategy, executionMode: effectiveMode, tasks: [], error: `Dispatch failed: ${e?.message ?? String(e)}`, totalDurationMs: Date.now() - start };
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
      "Backends: print (headless), rpc (multi-turn). " +
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
            `🤖 dispatching ${tasks.length} tasks [${strategy}]...`,
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

  // ── imagine — AI image generation via DALL-E ─────────────────

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
      try {
        // Resolve OpenAI API key
        const openaiModel = ctx.modelRegistry.find("openai", "gpt-4.1-mini");
        if (!openaiModel) {
          return { content: [{ type: "text", text: "OpenAI provider not configured. Add to models.json." }], isError: true };
        }
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(openaiModel);
        if (!auth.ok || !auth.apiKey) {
          return { content: [{ type: "text", text: `OpenAI auth failed: ${auth.error || "no key"}` }], isError: true };
        }

        // Call gpt-image-2 via Responses API (not Images API — sub2api doesn't support that)
        const baseUrl = openaiModel.baseUrl || "https://api.openai.com";
        const cleanBase = baseUrl.replace(/\/v1\/?$/, "");
        const response = await fetch(`${cleanBase}/v1/responses`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${auth.apiKey}`,
          },
          body: JSON.stringify({
            model: params.model || "gpt-image-2",
            input: params.prompt,
            image_generation: {
              quality: params.quality || "hd",
              size: params.size || "1024x1024",
              output_format: "png",
            },
          }),
        });

        if (!response.ok) {
          const err = await response.text().catch(() => "unknown");
          return { content: [{ type: "text", text: `Image generation failed: ${response.status} ${err.slice(0, 500)}` }], isError: true };
        }

        const data = await response.json() as any;

        // Extract base64 image from Responses API output
        let imageBase64 = "";
        for (const item of data?.output ?? []) {
          if (item.type === "image_generation_call" && item.result) {
            imageBase64 = item.result;
            break;
          }
        }

        if (!imageBase64) {
          return { content: [{ type: "text", text: "No image in response. Model may not support image generation." }], isError: true };
        }

        return {
          content: [
            { type: "text", text: `✅ Generated (${params.model || "gpt-image-2"}, ${params.size || "1024x1024"}, ${params.quality || "hd"})` },
            { type: "image", data: imageBase64, mimeType: "image/png" },
          ],
          details: { model: params.model || "gpt-image-2", size: params.size, quality: params.quality },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Image generation error: ${e?.message || String(e)}` }], isError: true };
      }
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
      "The tool auto-selects the best vision model available: gpt-5.5-pro > gpt-5.5 > claude-opus-4-7 > gpt-4.1.",
      "Returns the text analysis from the vision model.",
    ],
    parameters: Type.Object({
      imageBase64: Type.String({ description: "Base64 encoded image data" }),
      mimeType: Type.Optional(Type.String({ description: "Image MIME type, e.g. image/png" })),
      prompt: Type.String({ description: "What to analyze/look for in the image" }),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        // Check if current model already supports images — if so, suggest the LLM do it directly
        if (ctx.model?.input?.includes("image")) {
          return {
            content: [{ type: "text", text: "Current model supports images directly. No delegation needed. Describe the image in your prompt." }],
          };
        }

        // Find best vision model
        const visionModels = (await ctx.modelRegistry.getAvailable())
          .filter((m: any) => m.input?.includes("image"))
          .sort((a: any, b: any) => {
            const rank = (m: any) => {
              const id = m.id.toLowerCase();
              if (m.provider === "openai" && id.includes("gpt-5.5-pro")) return 10;
              if (m.provider === "openai" && id.includes("gpt-5.5")) return 9;
              if (m.provider === "anthropic" && id.includes("opus-4-7")) return 8;
              if (m.provider === "openai" && id.includes("gpt-5")) return 7;
              if (m.provider === "anthropic" && id.includes("opus")) return 6;
              if (m.provider === "openai" && id.includes("gpt-4.1")) return 5;
              if (m.provider === "anthropic" && id.includes("sonnet")) return 4;
              return 0;
            };
            return rank(b) - rank(a);
          });

        if (visionModels.length === 0) {
          return { content: [{ type: "text", text: "No vision-capable model available. Configure OpenAI or Anthropic with image support." }], isError: true };
        }

        const bestVision = visionModels[0];
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(bestVision);
        if (!auth.ok || !auth.apiKey) {
          return { content: [{ type: "text", text: `Auth failed for vision model: ${auth.error || "no key"}` }], isError: true };
        }

        // Call the vision model via completeSimple
        const { completeSimple } = await import("@mariozechner/pi-ai");
        const response = await completeSimple(
          bestVision,
          {
            messages: [{
              role: "user",
              content: [
                { type: "text", text: params.prompt },
                { type: "image", data: params.imageBase64, mimeType: params.mimeType || "image/png" },
              ],
              timestamp: Date.now(),
            }],
          },
          {
            apiKey: auth.apiKey,
            headers: auth.headers,
            maxTokens: 4096,
          },
        );

        const text = response.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");

        return {
          content: [{ type: "text", text: `## Vision Analysis (${bestVision.provider}/${bestVision.id})\n\n${text}` }],
          details: { model: `${bestVision.provider}/${bestVision.id}` },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Vision analysis error: ${e?.message || String(e)}` }], isError: true };
      }
    },
  });
}
