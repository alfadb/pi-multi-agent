/**
 * Print backend — spawns `pi --print` as a subprocess per task.
 * Simple, stateless, ideal for parallel single-turn analysis.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type { Task, TaskResult, ResolvedModel } from "../types.js";

export interface PrintBackendOptions {
  taskTimeoutMs: number;
  extraFlags: string[];
}

/**
 * Execute a single task via `pi --print`.
 * Writes prompt to temp file, runs pi, collects stdout.
 */
export async function executePrint(
  task: Task,
  resolved: ResolvedModel,
  opts: PrintBackendOptions,
): Promise<TaskResult> {
  const start = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ma-"));
  const promptFile = path.join(tmpDir, "prompt.md");
  const logFile = path.join(tmpDir, "stderr.log");

  try {
    fs.writeFileSync(promptFile, task.prompt, "utf8");

    const args = [
      "--model", `${resolved.provider}/${resolved.modelId}`,
      "--thinking", task.thinking,
      "--print",
      "--no-session",
      ...opts.extraFlags,
    ];

    if (task.tools) {
      args.push("--tools", task.tools);
    }

    const env = {
      ...process.env,
      [`${resolved.provider.toUpperCase()}_API_KEY`]: resolved.apiKey,
    };

    const result = await runPi(args, promptFile, logFile, env, opts.taskTimeoutMs);
    const durationMs = Date.now() - start;

    const output = result.stdout.trim();
    if (!output && result.stderr) {
      return {
        taskId: task.id,
        model: `${resolved.provider}/${resolved.modelId}`,
        role: task.role,
        output: "",
        error: result.stderr.slice(-500),
        durationMs,
      };
    }

    return {
      taskId: task.id,
      model: `${resolved.provider}/${resolved.modelId}`,
      role: task.role,
      output,
      durationMs,
    };
  } catch (e: any) {
    return {
      taskId: task.id,
      model: `${resolved.provider}/${resolved.modelId}`,
      role: task.role,
      output: "",
      error: e?.message ?? String(e),
      durationMs: Date.now() - start,
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function runPi(
  args: string[],
  promptFile: string,
  logFile: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000);
        reject(new Error(`Task timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    // stderr goes to logFile, but we also capture last bit for errors
    const logFd = fs.openSync(logFile, "w");
    child.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString();
      stderr = (stderr + s).slice(-2000);
      fs.writeSync(logFd, s);
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        try { fs.closeSync(logFd); } catch {}
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        try { fs.closeSync(logFd); } catch {}
        if (code === 0 || code === null) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`pi exited with code ${code}: ${stderr.slice(-300)}`));
        }
      }
    });

    // Write prompt to stdin
    const prompt = fs.readFileSync(promptFile, "utf8");
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}
