/**
 * imagine-core — pure image-generation function shared by main pi tool and
 * subagent tool injection. Calls sub2api Responses endpoint (proxy for
 * OpenAI gpt-image-2 / dall-e-3 / dall-e-2). Writes the resulting PNG to
 * the project-local output directory and optionally returns base64 for
 * inline display (when the *caller's* model supports image input).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

export interface ImagineInput {
  prompt: string;
  model?: string;
  size?: string;
  quality?: string;
  /** Style hint encoded into prompt; not an API param. */
  style?: string;
}

export interface ImagineDeps {
  /** Project root (where the output dir is created). */
  cwd: string;
  /**
   * Whether the caller can render image content inline. When true, the result
   * also includes the base64 payload so the caller can display it. When false,
   * only the file path is returned.
   */
  callerSupportsImages: boolean;
  /** Abort signal — propagated into fetch. */
  signal?: AbortSignal;
}

export interface ImagineOk {
  ok: true;
  /** Always populated: absolute path to the saved PNG. */
  filepath: string;
  /** Model used (echoed from request). */
  model: string;
  requestedSize?: string;
  actualSize?: string;
  requestedQuality?: string;
  actualQuality?: string;
  /** Only populated when caller can render images. */
  imageBase64?: string;
  mimeType?: string;
}
export interface ImagineErr {
  ok: false;
  error: string;
}
export type ImagineResult = ImagineOk | ImagineErr;

export async function generateImage(input: ImagineInput, deps: ImagineDeps): Promise<ImagineResult> {
  const apiKey = process.env.SUB2API_API_KEY_OPENAI || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error: "No OpenAI API key found. Set OPENAI_API_KEY or SUB2API_API_KEY_OPENAI.",
    };
  }

  // Style is intentionally not an OpenAI Responses API param — it's encoded
  // into the prompt because the Images API accepts "vivid"/"natural" but the
  // Responses image_generation_call path does not. Honor the contract by
  // appending a style hint to the prompt itself.
  const styledPrompt = input.style
    ? `${input.prompt}\n\n[Style: ${input.style}]`
    : input.prompt;

  const reqBody: Record<string, unknown> = {
    model: input.model || "gpt-image-2",
    input: styledPrompt,
  };
  if (input.size) reqBody.size = input.size;
  if (input.quality) reqBody.quality = input.quality;

  // NOTE: this endpoint is the alfadb-internal sub2api proxy, not OpenAI direct.
  // The proxy forwards to upstream OpenAI but rewrites quality/auth headers.
  // Both SUB2API_API_KEY_OPENAI and OPENAI_API_KEY are accepted; either way
  // the credential is sent to a *third party* (sub2api.alfadb.cn), not
  // OpenAI directly. Document this in any deployment that ships outside the
  // alfadb infrastructure. A future change should accept OPENAI_BASE_URL to
  // allow direct routing.
  let response: Response;
  try {
    response = await fetch("https://sub2api.alfadb.cn/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(reqBody),
      signal: deps.signal,
    });
  } catch (e: any) {
    return { ok: false, error: `Image generation network error: ${e?.message ?? String(e)}` };
  }

  if (!response.ok) {
    const err = await response.text().catch(() => "unknown");
    return {
      ok: false,
      error: `Image generation failed: ${response.status} ${err.slice(0, 500)}`,
    };
  }

  const data = (await response.json()) as any;

  // Extract base64 image and the actual size/quality the model used.
  let imageBase64 = "";
  let actualSize: string | undefined;
  let actualQuality: string | undefined;
  for (const item of data?.output ?? []) {
    if (item.type === "image_generation_call" && item.result) {
      imageBase64 = item.result;
      actualSize = item.size;
      actualQuality = item.quality;
      break;
    }
  }
  if (!imageBase64) {
    return { ok: false, error: "No image in response." };
  }

  // Save to disk under <cwd>/.pi-multi-agent-output/ (fallback to ~ if cwd missing).
  // Use async fs to avoid blocking the event loop while writing potentially
  // multi-MB PNG buffers — a sync write here would stall every other in-flight
  // task in a parallel dispatch.
  const outDir = path.join(deps.cwd || os.homedir(), ".pi-multi-agent-output");
  try {
    await fs.mkdir(outDir, { recursive: true });
  } catch {
    /* ignore */
  }
  // Date.now() alone collides under parallel dispatch (two subagents calling
  // imagine in the same millisecond would silently overwrite each other).
  // Append a 4-byte random suffix to make filenames collision-free even at
  // submillisecond rates.
  const suffix = crypto.randomBytes(4).toString("hex");
  const filename = `image-${Date.now()}-${suffix}.png`;
  const filepath = path.join(outDir, filename);
  try {
    await fs.writeFile(filepath, Buffer.from(imageBase64, "base64"));
  } catch (e: any) {
    return { ok: false, error: `Failed to save image: ${e?.message ?? String(e)}` };
  }

  return {
    ok: true,
    filepath,
    model: String(reqBody.model),
    requestedSize: input.size,
    actualSize,
    requestedQuality: input.quality,
    actualQuality,
    ...(deps.callerSupportsImages ? { imageBase64, mimeType: "image/png" } : {}),
  };
}
