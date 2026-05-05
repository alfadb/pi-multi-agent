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

// Default endpoint: alfadb's sub2api proxy. Override with PI_IMAGINE_BASE_URL.
const DEFAULT_IMAGINE_BASE_URL = "https://sub2api.alfadb.cn";
// Whether `baseUrl` points to a third-party proxy rather than openai.com
// directly. We err on the side of "third party" — only api.openai.com is
// considered first-party. sub2api.alfadb.cn, custom corp gateways, and
// other providers all count as third-party, which gates which env keys
// we accept (see comment in generateImage).
function isFirstPartyOpenAI(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return u.hostname === "api.openai.com";
  } catch {
    return false;
  }
}

export async function generateImage(input: ImagineInput, deps: ImagineDeps): Promise<ImagineResult> {
  const baseUrl = process.env.PI_IMAGINE_BASE_URL?.trim() || DEFAULT_IMAGINE_BASE_URL;

  // Credential routing rules:
  //   - SUB2API_API_KEY_OPENAI is provider-specific to alfadb's sub2api and
  //     by definition belongs to that proxy; always acceptable.
  //   - OPENAI_API_KEY is a *first-party* OpenAI credential. Sending it to
  //     a third-party proxy means handing off the user's OpenAI account to
  //     a vendor they did not consent to. We refuse this unless either
  //       (a) baseUrl points to api.openai.com (first-party), OR
  //       (b) the user explicitly opted in via PI_IMAGINE_ALLOW_OPENAI_KEY_PROXY=1
  //     This closes the silent-key-leak path where a user setting the
  //     standard OPENAI_API_KEY ships their OpenAI credentials to
  //     sub2api.alfadb.cn (or any other gateway) without disclosure.
  let apiKey = process.env.SUB2API_API_KEY_OPENAI;
  if (!apiKey) {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      const firstParty = isFirstPartyOpenAI(baseUrl);
      const optedIn = process.env.PI_IMAGINE_ALLOW_OPENAI_KEY_PROXY === "1";
      if (firstParty || optedIn) {
        apiKey = openaiKey;
      } else {
        return {
          ok: false,
          error:
            `OPENAI_API_KEY is set but PI_IMAGINE_BASE_URL is a third-party endpoint (${baseUrl}). ` +
            "Refusing to forward your OpenAI credential to a non-OpenAI host. " +
            "To proceed, either: " +
            "(a) set PI_IMAGINE_BASE_URL=https://api.openai.com to call OpenAI directly, " +
            "(b) set SUB2API_API_KEY_OPENAI to a sub2api-specific key, or " +
            "(c) set PI_IMAGINE_ALLOW_OPENAI_KEY_PROXY=1 to acknowledge the risk explicitly.",
        };
      }
    }
  }
  if (!apiKey) {
    return {
      ok: false,
      error: "No image-generation API key found. Set SUB2API_API_KEY_OPENAI for sub2api, or set OPENAI_API_KEY together with PI_IMAGINE_BASE_URL=https://api.openai.com for direct OpenAI access.",
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

  // baseUrl is from PI_IMAGINE_BASE_URL or the sub2api default. Both the
  // default and standard openai routing put the Responses endpoint at
  // /v1/responses, so we suffix that universally.
  const url = `${baseUrl.replace(/\/$/, "")}/v1/responses`;
  let response: Response;
  try {
    response = await fetch(url, {
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
