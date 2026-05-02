/**
 * Tmux backend — splits panes, sends pi commands via send-keys.
 *
 * Design:
 *   1. split-window → user's real shell (zsh/bash/fish), full env
 *   2. send-keys "pi --print 'prompt'" → single-turn, exits when done
 *   3. send-keys "pi --print 'next prompt'" → multi-turn, same pane
 *
 * No scripts, no source files, no RPC in tmux (RPC is headless).
 * Detection via && echo PI_MA_DONE marker after pi exits.
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
  return execFileSync("tmux", args, {
    input, encoding: "utf8", timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function getMainPaneId(): string { return tmux(["display-message", "-p", "#{pane_id}"]); }
function killPane(paneId: string): void { try { tmux(["kill-pane", "-t", paneId]); } catch {} }
function selectPane(paneId: string): void { try { tmux(["select-pane", "-t", paneId]); } catch {} }
function capturePane(paneId: string): string {
  try { return tmux(["capture-pane", "-p", "-t", paneId, "-S", "-", "-E", "-"]); }
  catch { return ""; }
}

function findPiPath(): string {
  for (const p of (process.env.PATH || "").split(":")) {
    try { if (fs.existsSync(path.join(p, "pi"))) return path.join(p, "pi"); } catch {}
  }
  return "pi";
}

// ── Shell-safe quoting ──────────────────────────────────────────

/** Escape a string for safe single-quote embedding in shell. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

// ── Pane lifecycle ──────────────────────────────────────────────

interface PaneState {
  paneId: string;
}

function splitPane(index: number): PaneState {
  const args = index === 0
    ? ["split-window", "-P", "-F", "#{pane_id}", "-h", "-l", "80"]
    : ["split-window", "-P", "-F", "#{pane_id}", "-v", "-l", "15"];
  return { paneId: tmux(args) };
}

function sendPiCommand(paneId: string, task: Task, prompt: string, extraFlags: string[], doneFile: string): void {
  const piPath = findPiPath();
  const modelArg = sq(`${task.model}`);
  const promptArg = sq(prompt);
  const flags = extraFlags.map(sq).join(" ");

  // Write DONE marker to a file after pi exits (avoids shell echo false positive)
  const cmd = `${piPath} --model ${modelArg} --thinking ${task.thinking} --print --no-session ${flags} ${promptArg} && echo done > ${sq(doneFile)}`;

  tmux(["send-keys", "-t", paneId, "-l", cmd]);
  tmux(["send-keys", "-t", paneId, "Enter"]);
}

async function waitForDone(paneId: string, doneFile: string, timeoutMs: number): Promise<{ output: string; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (fs.existsSync(doneFile)) {
      await new Promise((r) => setTimeout(r, 500));
      const output = extractPiOutput(capturePane(paneId));
      return { output, timedOut: false };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  return { output: extractPiOutput(capturePane(paneId)), timedOut: true };
}

function extractPiOutput(raw: string): string {
  return raw
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")  // CSI sequences
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "") // OSC sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "") // control chars
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      // Skip shell prompts and command echoes
      if (/^[%$#>]\s*$/.test(t)) return false;
      if (t.includes("--model") && t.includes("--print")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

// ── Single-turn ─────────────────────────────────────────────────

async function executeOneInPane(
  task: Task,
  opts: TmuxBackendOptions,
  index: number,
): Promise<TaskResult> {
  const start = Date.now();
  let pane: PaneState | undefined;

  try {
    pane = splitPane(index);
    const doneFile = path.join(os.tmpdir(), `pi-ma-done-${task.id}-${Date.now()}`);
    sendPiCommand(pane.paneId, task, task.prompt, opts.extraFlags, doneFile);
    const { output, timedOut } = await waitForDone(pane.paneId, doneFile, opts.taskTimeoutMs);

    killPane(pane.paneId);
    try { fs.unlinkSync(doneFile); } catch {}

    return {
      taskId: task.id, model: task.model, role: task.role,
      output: output || "(no output)",
      error: timedOut ? `Timed out after ${opts.taskTimeoutMs}ms` : undefined,
      durationMs: Date.now() - start,
    };
  } catch (e: any) {
    if (pane) killPane(pane.paneId);
    return { taskId: task.id, model: task.model, role: task.role, output: "", error: e?.message ?? String(e), durationMs: Date.now() - start };
  }
}

// ── Multi-turn (debate rounds) ─────────────────────────────────

export async function executeTmuxMultiTurn(
  tasks: Task[],
  rounds: string[][],
  opts: TmuxBackendOptions,
): Promise<TaskResult[][]> {
  const mainPaneId = getMainPaneId();
  const panes: (PaneState | null)[] = [];
  const allResults: TaskResult[][] = tasks.map(() => []);

  try {
    // Split panes
    for (let i = 0; i < tasks.length; i++) {
      panes.push(splitPane(i));
    }
    selectPane(mainPaneId);

    const numRounds = rounds[0]?.length ?? 1;
    for (let r = 0; r < numRounds; r++) {
      const start = Date.now();
      const jobs: Promise<{ idx: number; output: string; timedOut: boolean }>[] = [];

      for (let i = 0; i < tasks.length; i++) {
        const pane = panes[i];
        if (!pane) continue;
        const prompt = rounds[i]?.[r] ?? tasks[i].prompt;
        const doneFile = path.join(os.tmpdir(), `pi-ma-done-${tasks[i].id}-r${r}-${Date.now()}`);

        sendPiCommand(pane.paneId, tasks[i], prompt, opts.extraFlags, doneFile);

        jobs.push((async () => {
          const { output, timedOut } = await waitForDone(pane.paneId, doneFile, opts.taskTimeoutMs);
          try { fs.unlinkSync(doneFile); } catch {}
          return { idx: i, output, timedOut };
        })());
      }

      const roundOutputs = await Promise.all(jobs);
      for (const { idx, output, timedOut } of roundOutputs) {
        allResults[idx].push({
          taskId: tasks[idx].id, model: tasks[idx].model, role: tasks[idx].role,
          output: output || "(no output)",
          error: timedOut ? `Timed out after ${opts.taskTimeoutMs}ms` : undefined,
          durationMs: Date.now() - start,
        });
      }
    }

    // Kill all panes
    for (const pane of panes) {
      if (pane) killPane(pane.paneId);
    }

    return allResults;
  } catch (e: any) {
    for (const pane of panes) {
      if (pane) killPane(pane.paneId);
    }
    throw e;
  } finally {
    selectPane(mainPaneId);
  }
}

// ── Public API ──────────────────────────────────────────────────

export async function executeTmux(
  tasks: Task[],
  _resolvedModels: Map<string, ResolvedModel>,
  opts: TmuxBackendOptions,
): Promise<TaskResult[]> {
  const mainPaneId = getMainPaneId();
  const jobs = tasks.map((t, i) => executeOneInPane(t, opts, i));
  const results = await Promise.all(jobs);
  try { selectPane(mainPaneId); } catch {}
  return results;
}

export async function isTmuxAvailable(): Promise<boolean> {
  try { tmux(["display-message", "-p", "#S"]); return true; }
  catch { return false; }
}
