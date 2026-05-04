/**
 * vision-core — pure image-analysis function shared by main pi tool registration
 * and subagent tool injection. No ExtensionContext dependency: takes a model
 * registry, cwd (for path-based image loading), and abort signal as deps.
 *
 * Picks the strongest available vision-capable model (excluding `excludeMain`
 * if provided) per the user's configured preference order, then runs an
 * in-process pi-ai streamSimple call. Returns text + chosen model + usage.
 */

import * as fs from "node:fs";
import type { Model } from "@mariozechner/pi-ai";

export interface VisionInput {
  imageBase64?: string;
  path?: string;
  mimeType?: string;
  prompt: string;
}

export interface VisionDeps {
  /** ModelRegistry from ctx.modelRegistry — used to enumerate vision-capable models. */
  modelRegistry: any;
  /** Ordered preference list, e.g. ["openai/gpt-5.5-pro", "anthropic/claude-opus"]. */
  prefs: string[];
  /**
   * Model to exclude from candidates (typically the main agent's current model:
   * if it supported images we wouldn't be calling vision in the first place).
   * Pass undefined to consider all candidates.
   */
  excludeMain?: Model<any>;
  /** Abort signal — propagated into pi-ai stream so ESC cancels in flight. */
  signal?: AbortSignal;
  /** Per-call timeout in ms. Default 120_000. */
  timeoutMs?: number;
}

export interface VisionOk {
  ok: true;
  text: string;
  model: string;
  usage?: any;
  candidates: string[];
}
export interface VisionErr {
  ok: false;
  error: string;
}
export type VisionResult = VisionOk | VisionErr;

type ResolvedImage = { base64: string; mimeType: string };

/** Resolve image bytes from base64 or path; infer mime when path provided.
 *  Returns either ResolvedImage or a VisionErr (so callers can early-return). */
function resolveImage(input: VisionInput): ResolvedImage | VisionErr {
  let imageBase64 = input.imageBase64;
  let mimeType = input.mimeType || "image/png";
  if (input.path && !imageBase64) {
    try {
      const buf = fs.readFileSync(input.path);
      imageBase64 = buf.toString("base64");
      const ext = input.path.split(".").pop()?.toLowerCase();
      if (ext === "jpg" || ext === "jpeg") mimeType = "image/jpeg";
      else if (ext === "png") mimeType = "image/png";
      else if (ext === "webp") mimeType = "image/webp";
      else if (ext === "gif") mimeType = "image/gif";
    } catch (e: any) {
      return { ok: false, error: `Failed to read image: ${e.message ?? String(e)}` };
    }
  }
  if (!imageBase64) {
    return { ok: false, error: "No image provided. Pass imageBase64 or path." };
  }
  return { base64: imageBase64, mimeType };
}

/** Score = lower means more preferred. Substring match on model id. */
function scoreByPrefs(m: any, prefs: string[]): number {
  const id = String(m.id || "").toLowerCase();
  for (let i = 0; i < prefs.length; i++) {
    const slash = prefs[i].indexOf("/");
    if (slash < 0) continue;
    const pProv = prefs[i].slice(0, slash);
    const pPat = prefs[i].slice(slash + 1).toLowerCase();
    if (m.provider === pProv && id.includes(pPat)) return i;
  }
  return prefs.length;
}

export async function analyzeImage(input: VisionInput, deps: VisionDeps): Promise<VisionResult> {
  const img = resolveImage(input);
  if ("ok" in img && img.ok === false) return img;
  const resolved = img as ResolvedImage;

  const isExcluded = (m: any) =>
    !!deps.excludeMain && m.provider === deps.excludeMain.provider && m.id === deps.excludeMain.id;

  const candidates: any[] = (await deps.modelRegistry.getAvailable())
    .filter((m: any) => m.input?.includes("image"))
    .filter((m: any) => !isExcluded(m))
    .map((m: any) => ({ m, pref: scoreByPrefs(m, deps.prefs) }))
    .sort((a: any, b: any) => {
      if (a.pref !== b.pref) return a.pref - b.pref;
      // Same pref bucket: pricier input ≈ stronger model (rough proxy).
      return (b.m.cost?.input ?? 0) - (a.m.cost?.input ?? 0);
    })
    .map((x: any) => x.m);

  if (candidates.length === 0) {
    return {
      ok: false,
      error:
        "No vision-capable model available (other than the excluded main model). " +
        "Configure another provider with image support.",
    };
  }

  const best = candidates[0];
  const auth = await deps.modelRegistry.getApiKeyAndHeaders(best);
  if (!auth.ok || !auth.apiKey) {
    return { ok: false, error: `Auth failed for vision model: ${auth.error || "no key"}` };
  }

  try {
    const piAi: any = await import("@mariozechner/pi-ai");
    const userMsg = {
      role: "user" as const,
      content: [
        { type: "image" as const, data: resolved.base64, mimeType: resolved.mimeType },
        { type: "text" as const, text: input.prompt || "Describe this image" },
      ],
      timestamp: Date.now(),
    };
    const stream = piAi.streamSimple(
      best,
      { messages: [userMsg] },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: deps.signal,
        timeoutMs: deps.timeoutMs ?? 120_000,
        maxRetries: 1,
      },
    );
    const finalMsg = await stream.result();

    if (finalMsg.stopReason === "error" || finalMsg.stopReason === "aborted") {
      const reason = finalMsg.errorMessage || finalMsg.stopReason;
      return { ok: false, error: `Vision analysis failed (${best.provider}/${best.id}): ${reason}` };
    }

    const text = (finalMsg.content as any[])
      .filter((c) => c?.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    if (!text) {
      return {
        ok: false,
        error: `Vision model returned no text (stopReason=${finalMsg.stopReason}).`,
      };
    }

    return {
      ok: true,
      text,
      model: `${best.provider}/${best.id}`,
      usage: finalMsg.usage,
      candidates: candidates.slice(0, 5).map((m: any) => `${m.provider}/${m.id}`),
    };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    return {
      ok: false,
      error: `Vision analysis failed (${best.provider}/${best.id}): ${msg.slice(0, 500)}`,
    };
  }
}
