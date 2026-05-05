/**
 * vision-core — pure image-analysis function shared by main pi tool registration
 * and subagent tool injection. No ExtensionContext dependency: takes a model
 * registry, cwd (for path-based image loading), and abort signal as deps.
 *
 * Picks the strongest available vision-capable model (excluding `excludeMain`
 * if provided) per the user's configured preference order, then runs an
 * in-process pi-ai streamSimple call. Returns text + chosen model + usage.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import type { Model } from "@mariozechner/pi-ai";

/** Default per-call timeout for vision LLM streams. Vision models can be slow
 *  (multi-megapixel images, heavy reasoning); 2min is the historical default. */
const DEFAULT_VISION_TIMEOUT_MS = 120_000;
/** Vision calls are expensive; a single retry is enough — we don't want to
 *  silently pay for repeated failures. */
const DEFAULT_VISION_MAX_RETRIES = 1;
/** Allowed image extensions for path-based loads. Prevents the LLM from
 *  coercing vision into reading arbitrary text files (auth.json, /etc/passwd,
 *  ~/.ssh/*) that might happen to be readable. Vision providers reject
 *  non-image bytes anyway, but exfiltration via base64 round-trip to a
 *  third-party model is a real risk we're closing. */
const ALLOWED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export interface VisionInput {
  imageBase64?: string;
  path?: string;
  mimeType?: string;
  prompt: string;
}

export interface VisionDeps {
  /** ModelRegistry from ctx.modelRegistry — used to enumerate vision-capable models. */
  modelRegistry: any;
  /** Ordered preference list, e.g. ["openai/gpt-5.5", "anthropic/claude-opus"]. */
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
  /**
   * Project cwd. Path-based image loads MUST resolve under this root — prevents
   * an LLM-controlled path from reaching arbitrary files. When undefined,
   * absolute paths and `..` traversals are still rejected; only relative paths
   * resolved against process.cwd() are allowed.
   */
  cwd?: string;
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

/** Validate that `userPath` is safe to read: must have an image extension,
 *  must resolve under `cwd` (or process.cwd() if cwd undefined). Returns the
 *  absolute path on success, or a VisionErr.
 *
 *  Threat model: the LLM populates input.path. Without these checks a
 *  prompt-injected subagent (or a confused-deputy main agent) could request
 *  vision on /etc/passwd, ~/.ssh/id_rsa, .pi/auth.json — we'd base64-encode
 *  those bytes and ship them to a third-party vision provider, leaking
 *  secrets. Two layers of defense:
 *    1. Extension allowlist — non-image bytes have no business being read.
 *    2. Path containment — even valid PNGs outside cwd shouldn't be readable
 *       (a subagent shouldn't roam beyond the project tree).
 */
function validateImagePath(userPath: string, cwd: string | undefined): { ok: true; abs: string; ext: string } | VisionErr {
  const ext = path.extname(userPath).toLowerCase();
  if (!ALLOWED_IMAGE_EXTS.has(ext)) {
    return {
      ok: false,
      error: `Image path extension '${ext || "(none)"}' not allowed. Permitted: ${[...ALLOWED_IMAGE_EXTS].join(", ")}`,
    };
  }
  const rootRaw = path.resolve(cwd ?? process.cwd());
  const absRaw = path.resolve(rootRaw, userPath);

  // TOCTOU symlink defense: a path-string check on the user-supplied path
  // alone passes for `<cwd>/evil.png` even when evil.png is a symlink to
  // /etc/passwd or ~/.ssh/id_rsa. fs.readFile follows symlinks, so we'd
  // base64-encode the secret and ship it to a third-party vision provider.
  //
  // Defense: resolve symlinks on BOTH sides, then prefix-check. If the
  // symlink target escapes the project root, reject. If the user-path
  // doesn't exist yet, fall back to the lexical check (it can't be a
  // symlink-to-secret if it doesn't exist).
  let root: string;
  let abs: string;
  try { root = fsSync.realpathSync(rootRaw); }
  catch { root = rootRaw; }
  try { abs = fsSync.realpathSync(absRaw); }
  catch { abs = absRaw; }

  // Trailing-separator guard: ensure /a/bc isn't treated as inside /a/b.
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    return {
      ok: false,
      error: `Image path '${userPath}' resolves outside the project root (after symlink resolution).`,
    };
  }
  return { ok: true, abs, ext };
}

/** Resolve image bytes from base64 or path; infer mime when path provided.
 *  Uses async fs to avoid blocking the event loop on disk read.
 *  Returns either ResolvedImage or a VisionErr (so callers can early-return). */
async function resolveImage(
  input: VisionInput,
  cwd: string | undefined,
): Promise<ResolvedImage | VisionErr> {
  let imageBase64 = input.imageBase64;
  let mimeType = input.mimeType || "image/png";
  if (input.path && !imageBase64) {
    const v = validateImagePath(input.path, cwd);
    if (v.ok === false) return v;
    try {
      const buf = await fs.readFile(v.abs);
      imageBase64 = buf.toString("base64");
      if (v.ext === ".jpg" || v.ext === ".jpeg") mimeType = "image/jpeg";
      else if (v.ext === ".png") mimeType = "image/png";
      else if (v.ext === ".webp") mimeType = "image/webp";
      else if (v.ext === ".gif") mimeType = "image/gif";
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
  const img = await resolveImage(input, deps.cwd);
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
    // The excluded main model itself supports images. Calling vision when
    // the caller already has image input would be a no-op round-trip; surface
    // a clear actionable message instead of a misleading "none available".
    if (deps.excludeMain && (deps.excludeMain as any).input?.includes?.("image")) {
      return {
        ok: false,
        error:
          `Caller's own model (${deps.excludeMain.provider}/${deps.excludeMain.id}) ` +
          "supports image input — pass the image directly in your prompt instead of " +
          "calling vision. (vision tool exists to delegate to a *different* model.)",
      };
    }
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
        timeoutMs: deps.timeoutMs ?? DEFAULT_VISION_TIMEOUT_MS,
        maxRetries: DEFAULT_VISION_MAX_RETRIES,
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
