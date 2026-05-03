/**
 * Resolve the pi CLI entrypoint in a cross-platform way.
 *
 * Why: `spawn("pi", ...)` fails on Windows because Node's spawn doesn't
 * execute .cmd/.bat shims without shell:true. nvm-windows installs `pi.cmd`,
 * so `ENOENT` is raised. Instead, resolve the package's `dist/cli.js` and
 * run it with the current `process.execPath` (same node as parent).
 *
 * Resolution order:
 *   1. require.resolve("@mariozechner/pi-coding-agent/package.json") → dist/cli.js
 *   2. PI_CLI_PATH env override (escape hatch)
 *   3. Last resort: "pi" via shell (Windows-friendly, but unsafe with arbitrary args)
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";

export interface PiCommand {
  /** Executable to spawn (e.g. process.execPath, or "pi" for shell fallback). */
  command: string;
  /** Args to prepend before user args (e.g. [cliJsPath]). */
  prefixArgs: string[];
  /** Whether spawn() needs shell:true (Windows .cmd fallback). */
  shell: boolean;
}

let cached: PiCommand | null = null;

export function resolvePiCommand(): PiCommand {
  if (cached) return cached;

  // 1. Env override
  const envPath = process.env.PI_CLI_PATH;
  if (envPath && fs.existsSync(envPath)) {
    cached = { command: process.execPath, prefixArgs: [envPath], shell: false };
    return cached;
  }

  // 2. require.resolve from this file's location
  try {
    const req = createRequire(import.meta.url);
    const pkgJsonPath = req.resolve("@mariozechner/pi-coding-agent/package.json");
    const pkgDir = path.dirname(pkgJsonPath);
    const cliPath = path.join(pkgDir, "dist", "cli.js");
    if (fs.existsSync(cliPath)) {
      cached = { command: process.execPath, prefixArgs: [cliPath], shell: false };
      return cached;
    }
  } catch {
    // fall through
  }

  // 3. Shell fallback — relies on PATH + shell to find pi/pi.cmd
  cached = { command: "pi", prefixArgs: [], shell: true };
  return cached;
}
