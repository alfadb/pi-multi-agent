/**
 * subagent-tools — resolve a Task.tools allowlist string into actual SDK Tool
 * instances scoped to the dispatch. Subagents intentionally cannot access
 * arbitrary host extensions; the whitelist is hard-coded here so tool
 * delegation stays explicit and reviewable.
 *
 * Whitelisted entries:
 *   - SDK built-ins: read, bash, edit, write, grep, find, ls
 *   - Aliases: "readonly" (=read,grep,find,ls), "coding" (=read,bash,edit,write,grep,find,ls)
 *   - Self-delegatable multi-agent tools: vision, imagine
 *
 * Anything else (including multi_dispatch and third-party extension tools) is
 * rejected with a structured error. Forwarding the host ExtensionContext into
 * subagents is unsafe; future delegation of foreign tools should land via a
 * proper ToolDefinition.delegatable contract upstream.
 */

import type { Model } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { analyzeImage } from "./tools/vision-core.js";
import { generateImage } from "./tools/imagine-core.js";

const SDK_BUILTINS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const ALIASES: Record<string, string[]> = {
  readonly: ["read", "grep", "find", "ls"],
  coding: ["read", "bash", "edit", "write", "grep", "find", "ls"],
};
const MULTI_AGENT_DELEGATABLE = new Set(["vision", "imagine"]);

/** Hard-coded refusal list — for clearer error messages. */
const HARD_DENY = new Set(["multi_dispatch"]);

export interface SubagentToolDeps {
  cwd: string;
  modelRegistry: any;
  /**
   * Subagent's own model. Used by vision to exclude the *caller's* model from
   * vision candidates (matches main pi semantics: don't delegate to yourself).
   */
  taskModel: Model<any>;
  visionPrefs: string[];
}

/** Expand aliases and de-duplicate. Returns canonical lowercase names. */
function expandNames(csv: string): string[] {
  const raw = csv.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const out = new Set<string>();
  for (const name of raw) {
    if (ALIASES[name]) {
      for (const real of ALIASES[name]) out.add(real);
    } else {
      out.add(name);
    }
  }
  return [...out];
}

/** Validate names against the whitelist. Returns rejected entries (empty = all OK). */
export function validateTools(csv: string | undefined): { names: string[]; rejected: string[] } {
  if (!csv) return { names: [], rejected: [] };
  const names = expandNames(csv);
  const rejected: string[] = [];
  for (const n of names) {
    if (SDK_BUILTINS.has(n)) continue;
    if (MULTI_AGENT_DELEGATABLE.has(n)) continue;
    rejected.push(n);
  }
  return { names, rejected };
}

/** Build a human-readable rejection message including hint when possible. */
export function rejectionMessage(rejected: string[]): string {
  const lines: string[] = [
    `Task.tools rejected: ${rejected.join(", ")}`,
    "",
    "Subagent tools whitelist:",
    "  SDK built-ins: read, bash, edit, write, grep, find, ls",
    "  Aliases: readonly (=read,grep,find,ls), coding (=read+bash+edit+write+grep+find+ls)",
    "  Multi-agent: vision, imagine",
  ];
  for (const r of rejected) {
    if (HARD_DENY.has(r)) {
      lines.push("");
      lines.push(`'${r}' is intentionally not delegatable to subagents (would enable nested dispatch).`);
    }
  }
  return lines.join("\n");
}

/** Build the full Tool[] for a subagent given its allowlist. */
export async function buildSubagentTools(
  csv: string | undefined,
  deps: SubagentToolDeps,
): Promise<{ tools: AgentTool[]; rejected: string[] }> {
  if (!csv) return { tools: [], rejected: [] };
  const { names, rejected } = validateTools(csv);
  if (rejected.length > 0) return { tools: [], rejected };

  const tools: AgentTool[] = [];

  // SDK built-ins via dynamic import (avoids pulling tool deps when unused).
  // pi-coding-agent exports per-name factories rather than a generic one.
  const sdkNames = names.filter(n => SDK_BUILTINS.has(n));
  if (sdkNames.length > 0) {
    const sdk: any = await import("@mariozechner/pi-coding-agent");
    const factories: Record<string, (cwd: string) => any> = {
      read: sdk.createReadTool,
      bash: sdk.createBashTool,
      edit: sdk.createEditTool,
      write: sdk.createWriteTool,
      grep: sdk.createGrepTool,
      find: sdk.createFindTool,
      ls: sdk.createLsTool,
    };
    for (const n of sdkNames) {
      const factory = factories[n];
      if (factory) tools.push(factory(deps.cwd));
    }
  }

  // vision adapter: subagent uses its own model as excludeMain.
  if (names.includes("vision")) {
    tools.push(makeVisionTool(deps));
  }
  // imagine adapter: callerSupportsImages keys off taskModel input modalities.
  if (names.includes("imagine")) {
    tools.push(makeImagineTool(deps));
  }

  return { tools, rejected: [] };
}

function makeVisionTool(deps: SubagentToolDeps): AgentTool {
  return {
    name: "vision",
    label: "Vision (subagent)",
    description:
      "Analyze images using the best available vision model. Returns text analysis. " +
      "Auto-selects from available vision-capable models.",
    parameters: Type.Object({
      imageBase64: Type.Optional(Type.String({ description: "Base64 encoded image data" })),
      path: Type.Optional(Type.String({ description: "Path to image file (alternative to imageBase64)" })),
      mimeType: Type.Optional(Type.String({ description: "Image MIME type, e.g. image/png" })),
      prompt: Type.String({ description: "What to analyze/look for in the image" }),
    }) as any,
    async execute(_id: string, params: any, signal?: AbortSignal) {
      const r = await analyzeImage(params, {
        modelRegistry: deps.modelRegistry,
        prefs: deps.visionPrefs,
        excludeMain: deps.taskModel,
        signal,
      });
      if (r.ok === false) {
        return { content: [{ type: "text", text: r.error }], details: { error: r.error }, isError: true };
      }
      return {
        content: [{ type: "text", text: `## Vision Analysis (${r.model})\n\n${r.text}` }],
        details: { model: r.model, usage: r.usage, candidates: r.candidates },
      };
    },
  } as any;
}

function makeImagineTool(deps: SubagentToolDeps): AgentTool {
  // taskModel.input is the modality list; subagents almost never render images,
  // but we honor the same semantics as main pi for consistency.
  const callerSupportsImages = !!(deps.taskModel as any)?.input?.includes?.("image");
  return {
    name: "imagine",
    label: "Imagine (subagent)",
    description:
      "Generate images using DALL-E / gpt-image-2. Saves PNG to project output dir. " +
      "Returns the file path; image bytes are returned only if caller supports images.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Image description/prompt" }),
      model: Type.Optional(Type.String({ description: "Image model: gpt-image-2 (default), dall-e-3, dall-e-2" })),
      size: Type.Optional(Type.String({ description: "1024x1024, 1792x1024, or 1024x1792" })),
      quality: Type.Optional(Type.String({ description: "standard or hd" })),
      style: Type.Optional(Type.String({ description: "vivid or natural (encoded into prompt)" })),
    }) as any,
    async execute(_id: string, params: any, signal?: AbortSignal) {
      const r = await generateImage(params, {
        cwd: deps.cwd,
        callerSupportsImages,
        signal,
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
  } as any;
}
