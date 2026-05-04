/**
 * imagine-core — pure image-generation function shared by main pi tool and
 * subagent tool injection. Calls sub2api Responses endpoint (proxy for
 * OpenAI gpt-image-2 / dall-e-3 / dall-e-2). Writes the resulting PNG to
 * the project-local output directory and optionally returns base64 for
 * inline display (when the *caller's* model supports image input).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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

  const reqBody: Record<string, unknown> = {
    model: input.model || "gpt-image-2",
    input: input.prompt,
  };
  if (input.size) reqBody.size = input.size;
  if (input.quality) reqBody.quality = input.quality;

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
  const outDir = path.join(deps.cwd || os.homedir(), ".pi-multi-agent-output");
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch {
    /* ignore */
  }
  const filename = `image-${Date.now()}.png`;
  const filepath = path.join(outDir, filename);
  try {
    fs.writeFileSync(filepath, Buffer.from(imageBase64, "base64"));
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
