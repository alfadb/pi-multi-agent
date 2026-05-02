/**
 * RPC backend — spawns `pi --mode rpc` as a persistent subprocess.
 * Supports multi-turn interactions (debate rounds, chain handoffs).
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type { Task, TaskResult, ResolvedModel } from "../types.js";

export interface RpcBackendOptions {
  taskTimeoutMs: number;
  extraFlags: string[];
}

interface RpcSession {
  proc: ChildProcess;
  stdoutBuf: string;
  pendingResolve: ((text: string) => void) | null;
  pendingReject: ((err: Error) => void) | null;
  timer: NodeJS.Timeout | null;
  model: string;
  closed: boolean;
}

const sessions = new Map<string, RpcSession>();

/**
 * Execute a single-turn task via RPC.
 * Starts a short-lived RPC session, sends prompt, collects until agent_end.
 */
export async function executeRpc(
  task: Task,
  resolved: ResolvedModel,
  opts: RpcBackendOptions,
): Promise<TaskResult> {
  const start = Date.now();
  const sessionKey = `${task.id}-${Date.now()}`;

  try {
    const args = [
      "--model", `${resolved.provider}/${resolved.modelId}`,
      "--thinking", task.thinking,
      "--mode", "rpc",
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

    const proc = spawn("pi", args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Send prompt command
    const promptCmd = JSON.stringify({
      type: "prompt",
      message: task.prompt,
    }) + "\n";
    proc.stdin?.write(promptCmd);

    // Collect response until agent_end
    const output = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`RPC task timed out after ${opts.taskTimeoutMs}ms`));
      }, opts.taskTimeoutMs);

      let assistantText = "";

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        // Parse JSONL lines
        const lines = stdout.split("\n");
        // Keep incomplete line for next chunk
        const lastLine = lines.pop() ?? "";
        stdout = lastLine;

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "message_update") {
              const delta = event.assistantMessageEvent;
              if (delta?.type === "text_delta" && delta.delta) {
                assistantText += delta.delta;
              }
            }
            if (event.type === "agent_end") {
              clearTimeout(timer);
              // If no streaming text, extract from messages
              if (!assistantText && event.messages?.length) {
                for (const msg of event.messages) {
                  if (msg.role === "assistant" && msg.content) {
                    for (const block of msg.content) {
                      if (block.type === "text") {
                        assistantText += block.text;
                      }
                    }
                  }
                }
              }
              resolve(assistantText);
            }
          } catch {
            // Skip non-JSON lines (banner, etc.)
          }
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (assistantText) {
          resolve(assistantText);
        } else if (code !== 0 && code !== null) {
          reject(new Error(`pi RPC exited with code ${code}: ${stderr.slice(-300)}`));
        } else {
          resolve(assistantText || "");
        }
      });
    });

    const durationMs = Date.now() - start;

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
  }
}

/**
 * Multi-turn RPC session — for debate rounds and chain handoffs.
 */
export async function executeRpcMultiTurn(
  task: Task,
  resolved: ResolvedModel,
  turns: string[], // each string is a prompt for one turn
  opts: RpcBackendOptions,
): Promise<string[]> {
  const results: string[] = [];

  for (const turnPrompt of turns) {
    const turnTask: Task = { ...task, prompt: turnPrompt };
    const result = await executeRpc(turnTask, resolved, opts);
    if (result.error) {
      results.push(`[ERROR: ${result.error}]`);
      break;
    }
    results.push(result.output);
  }

  return results;
}

/**
 * Clean up all active RPC sessions.
 */
export function cleanupRpcSessions(): void {
  for (const [key, session] of sessions) {
    try { session.proc.kill("SIGTERM"); } catch {}
    sessions.delete(key);
  }
}
