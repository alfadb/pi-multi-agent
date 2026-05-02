/**
 * Tmux backend — splits current window into panes for real-time visibility.
 *
 * Uses `tmux split-window` via execFileSync (proven to work from extensions).
 * Each task gets its own pane running `pi --print`. Panes are killed after
 * output collection.
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
  mainPaneId: string,
): Promise<TaskResult> {
  const start = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ma-"));
  const exitFile = path.join(tmpDir, "exit.txt");

  try {
    // Find pi
    const piPath = findPiPath();

    // Write launch script
    const prompt = task.prompt;
    const promptFile = path.join(tmpDir, "prompt.md");
    fs.writeFileSync(promptFile, prompt, "utf8");

    const script = `#!/bin/bash
set -euo pipefail
echo "=== START:${task.id} ==="
${piPath} --model ${task.model} --thinking ${task.thinking} --print --no-session ${opts.extraFlags.join(" ")} < '${promptFile}'
EC=$?
echo "=== EXIT:$EC ==="
echo "=== DONE:${task.id} ==="
echo "done" > '${exitFile}'
read -n 1 -s -r -p "Press any key..."
`;
    const scriptFile = path.join(tmpDir, "run.sh");
    fs.writeFileSync(scriptFile, script, "utf8");
    fs.chmodSync(scriptFile, 0o755);

    // Split pane: first horizontal, rest vertical
    const isFirst = true; // We don't track this easily — just use same layout
    const newPaneId = tmux([
      "split-window", "-P", "-F", "#{pane_id}",
      "-h", "-l", "80",
      `bash '${scriptFile}'`,
    ]);

    // Wait for exit file
    const deadline = Date.now() + opts.taskTimeoutMs;
    let output = "";
    let error: string | undefined;

    while (Date.now() < deadline) {
      if (fs.existsSync(exitFile)) {
        output = capturePane(newPaneId);
        killPane(newPaneId);
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!output && !error) {
      error = `Timed out after ${opts.taskTimeoutMs}ms`;
      output = capturePane(newPaneId);
      killPane(newPaneId);
    }

    // Clean up output: extract between START and DONE
    const startMarker = `=== START:${task.id} ===`;
    const doneMarker = `=== DONE:${task.id} ===`;
    const startIdx = output.indexOf(startMarker);
    const doneIdx = output.indexOf(doneMarker);
    if (startIdx !== -1 && doneIdx !== -1) {
      output = output.slice(startIdx + startMarker.length, doneIdx).trim();
    }

    return {
      taskId: task.id,
      model: task.model,
      role: task.role,
      output: output || "(no output)",
      error,
      durationMs: Date.now() - start,
    };
  } catch (e: any) {
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

  // Run all tasks in parallel
  const jobs = tasks.map((task) => executeOneInPane(task, opts, mainPaneId));
  const results = await Promise.all(jobs);

  // Select back to main pane
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
