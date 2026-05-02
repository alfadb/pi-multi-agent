/**
 * Tmux backend — splits panes for real-time visibility.
 *
 * Two-step pattern:
 *   1. split-window → creates pane with user's real shell (no inline command)
 *   2. send-keys → injects commands into the pane's shell
 *
 * This preserves the user's shell (zsh/bash/fish), PATH, aliases, env vars.
 */

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type { Task, TaskResult, ResolvedModel } from "../types.js";

export interface TmuxBackendOptions {
  taskTimeoutMs: number;
  extraFlags: string[];
}

// ── Sync tmux helpers ───────────────────────────────────────────

function tmux(args: string[], input?: string): string {
  const result = execFileSync("tmux", args, {
    input,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return result.trim();
}

function getMainPaneId(): string {
  return tmux(["display-message", "-p", "#{pane_id}"]);
}

function killPane(paneId: string): void {
  try { tmux(["kill-pane", "-t", paneId]); } catch {}
}

function capturePane(paneId: string): string {
  try {
    return tmux(["capture-pane", "-p", "-t", paneId, "-S", "-", "-E", "-"]);
  } catch {
    return "";
  }
}

// ── Execute a task in a tmux pane ──────────────────────────────

async function executeOneInPane(
  task: Task,
  opts: TmuxBackendOptions,
  index: number,
): Promise<TaskResult> {
  const start = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ma-"));
  const exitFile = path.join(tmpDir, "exit.txt");
  const promptFile = path.join(tmpDir, "prompt.md");

  let paneId: string | undefined;

  try {
    // Find pi
    const piPath = findPiPath();

    // Write prompt to file
    fs.writeFileSync(promptFile, task.prompt, "utf8");

    // Build the command — write to temp file, then source it to avoid shell echo
    const markerPrefix = `PI_MA_${task.id}_`;
    const cmdFile = path.join(tmpDir, "cmd.sh");
    fs.writeFileSync(cmdFile, [
      `echo "${markerPrefix}START"`,
      `${piPath} --model ${task.model} --thinking ${task.thinking} --print --no-session ${opts.extraFlags.join(" ")} < '${promptFile}'`,
      `RC=$?`,
      `echo "${markerPrefix}EXIT:$RC"`,
      `echo "${markerPrefix}DONE"`,
      `echo "done" > '${exitFile}'`,
    ].join("\n"), "utf8");
    fs.chmodSync(cmdFile, 0o755);

    // ── Step 1: Split pane (user's shell, no command) ──
    const splitArgs = index === 0
      ? ["split-window", "-P", "-F", "#{pane_id}", "-h", "-l", "80"]
      : ["split-window", "-P", "-F", "#{pane_id}", "-v", "-l", "15"];

    paneId = tmux(splitArgs);

    // ── Step 2: Source the temp script (sends a minimal command to shell) ──
    tmux(["send-keys", "-t", paneId, "-l", `source '${cmdFile}'`]);
    tmux(["send-keys", "-t", paneId, "Enter"]);

    // ── Poll for exit file ──
    const deadline = Date.now() + opts.taskTimeoutMs;
    let output = "";
    let error: string | undefined;

    while (Date.now() < deadline) {
      if (fs.existsSync(exitFile)) {
        // Wait a beat for all output to flush
        await new Promise((r) => setTimeout(r, 500));
        output = capturePane(paneId!);
        killPane(paneId!);
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!output && !error) {
      error = `Timed out after ${opts.taskTimeoutMs}ms`;
      output = capturePane(paneId!);
      killPane(paneId!);
    }

    // Extract output between START and EXIT markers (pi's actual output)
    const startMarker = `${markerPrefix}START`;
    const exitMarker = `${markerPrefix}EXIT`;
    const si = output.indexOf(startMarker);
    const ei = output.indexOf(exitMarker);
    if (si !== -1 && ei !== -1 && ei > si) {
      output = output.slice(si + startMarker.length, ei).trim();
    }

    // Strip ANSI escape codes from captured output
    output = output
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      .trim();

    return {
      taskId: task.id,
      model: task.model,
      role: task.role,
      output: output || "(no output)",
      error,
      durationMs: Date.now() - start,
    };
  } catch (e: any) {
    if (paneId) killPane(paneId);
    return {
      taskId: task.id,
      model: task.model,
      role: task.role,
      output: "",
      error: e?.message ?? String(e),
      durationMs: Date.now() - start,
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function findPiPath(): string {
  const paths = (process.env.PATH || "").split(":");
  for (const p of paths) {
    const candidate = path.join(p, "pi");
    try { if (fs.existsSync(candidate)) return candidate; } catch {}
  }
  return "pi";
}

// ── Public API ──────────────────────────────────────────────────

export async function executeTmux(
  tasks: Task[],
  _resolvedModels: Map<string, ResolvedModel>,
  opts: TmuxBackendOptions,
  _roundsPerTask?: Map<string, string[]>,
): Promise<TaskResult[]> {
  const mainPaneId = getMainPaneId();

  const jobs = tasks.map((task, i) => executeOneInPane(task, opts, i));
  const results = await Promise.all(jobs);

  try { tmux(["select-pane", "-t", mainPaneId]); } catch {}

  return results;
}

export async function isTmuxAvailable(): Promise<boolean> {
  try {
    tmux(["display-message", "-p", "#S"]);
    return true;
  } catch {
    return false;
  }
}
