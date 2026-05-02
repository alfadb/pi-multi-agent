/**
 * Tmux backend — splits panes for real-time visibility.
 *
 * Two-step pattern:
 *   1. split-window → creates pane with user's real shell
 *   2. send-keys → injects commands into the pane's shell
 *
 * Supports single-turn (print backend) and multi-turn (debate/chain rounds).
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

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .trim();
}

function extractOutput(raw: string, taskId: string): string {
  const prefix = `PI_MA_${taskId}_`;
  const si = raw.indexOf(`${prefix}START`);
  const ei = raw.indexOf(`${prefix}EXIT`);
  if (si !== -1 && ei !== -1 && ei > si) {
    return raw.slice(si + `${prefix}START`.length, ei).trim();
  }
  return raw.trim();
}

// ── Pane lifecycle ──────────────────────────────────────────────

interface PaneState {
  paneId: string;
  tmpDir: string;
}

function splitPane(taskId: string, index: number): PaneState {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ma-"));
  const args = index === 0
    ? ["split-window", "-P", "-F", "#{pane_id}", "-h", "-l", "80"]
    : ["split-window", "-P", "-F", "#{pane_id}", "-v", "-l", "15"];
  const paneId = tmux(args);
  return { paneId, tmpDir };
}

function sendPrompt(
  pane: PaneState,
  task: Task,
  prompt: string,
  extraFlags: string[],
): string {
  const piPath = findPiPath();
  const markerPrefix = `PI_MA_${task.id}_`;

  // Write prompt and exit marker path
  const promptFile = path.join(pane.tmpDir, "prompt.md");
  const exitFile = path.join(pane.tmpDir, "exit.txt");
  fs.writeFileSync(promptFile, prompt, "utf8");
  // Clear previous exit marker
  try { fs.unlinkSync(exitFile); } catch {}

  // Write command script
  const cmdFile = path.join(pane.tmpDir, "cmd.sh");
  fs.writeFileSync(cmdFile, [
    `echo "${markerPrefix}START"`,
    `${piPath} --model ${task.model} --thinking ${task.thinking} --print --no-session ${extraFlags.join(" ")} < '${promptFile}'`,
    `RC=$?`,
    `echo "${markerPrefix}EXIT:$RC"`,
    `echo "${markerPrefix}DONE"`,
    `echo "done" > '${exitFile}'`,
    `echo "WAITING_FOR_NEXT..."`,
  ].join("\n"), "utf8");
  fs.chmodSync(cmdFile, 0o755);

  // Send to pane
  tmux(["send-keys", "-t", pane.paneId, "-l", `source '${cmdFile}'`]);
  tmux(["send-keys", "-t", pane.paneId, "Enter"]);

  return exitFile;
}

async function waitForExit(
  paneId: string,
  exitFile: string,
  taskId: string,
  timeoutMs: number,
): Promise<{ output: string; error?: string }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (fs.existsSync(exitFile)) {
      await new Promise((r) => setTimeout(r, 500));
      const raw = stripAnsi(capturePane(paneId));
      return { output: extractOutput(raw, taskId) };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  return {
    output: stripAnsi(capturePane(paneId)),
    error: `Timed out after ${timeoutMs}ms`,
  };
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
    pane = splitPane(task.id, index);
    const exitFile = sendPrompt(pane, task, task.prompt, opts.extraFlags);
    const { output, error } = await waitForExit(pane.paneId, exitFile, task.id, opts.taskTimeoutMs);

    killPane(pane.paneId);

    return {
      taskId: task.id, model: task.model, role: task.role,
      output: output || "(no output)", error, durationMs: Date.now() - start,
    };
  } catch (e: any) {
    if (pane) killPane(pane.paneId);
    return { taskId: task.id, model: task.model, role: task.role, output: "", error: e?.message ?? String(e), durationMs: Date.now() - start };
  } finally {
    if (pane) try { fs.rmSync(pane.tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Multi-turn (debate/ensemble) ─────────────────────────────────

/**
 * Execute multi-turn tasks in tmux panes.
 * Each task gets a persistent pane. After each round, outputs are collected
 * and the next round's prompt is sent. Panes are killed after all rounds.
 */
export async function executeTmuxMultiTurn(
  tasks: Task[],
  rounds: string[][],       // rounds[taskIndex][roundIndex] = prompt for that round
  opts: TmuxBackendOptions,
): Promise<TaskResult[][]> {   // results[taskIndex][roundIndex]
  const mainPaneId = getMainPaneId();
  const panes: (PaneState | null)[] = [];
  const allRoundResults: TaskResult[][] = tasks.map(() => []);

  try {
    // Split panes for all tasks
    for (let i = 0; i < tasks.length; i++) {
      panes.push(splitPane(tasks[i].id, i));
    }
    selectPane(mainPaneId);

    // Process each round
    const numRounds = rounds[0]?.length ?? 1;
    for (let r = 0; r < numRounds; r++) {
      const start = Date.now();
      const jobs: Promise<{ idx: number; output: string; error?: string }>[] = [];

      for (let i = 0; i < tasks.length; i++) {
        const pane = panes[i];
        if (!pane) continue;
        const task = tasks[i];
        const prompt = rounds[i]?.[r] ?? task.prompt;

        jobs.push((async () => {
          const exitFile = sendPrompt(pane, task, prompt, opts.extraFlags);
          const { output, error } = await waitForExit(pane.paneId, exitFile, task.id, opts.taskTimeoutMs);
          return { idx: i, output, error };
        })());
      }

      const roundOutputs = await Promise.all(jobs);
      for (const { idx, output, error } of roundOutputs) {
        allRoundResults[idx].push({
          taskId: tasks[idx].id,
          model: tasks[idx].model,
          role: tasks[idx].role,
          output: output || "(no output)",
          error,
          durationMs: Date.now() - start,
        });
      }
    }

    // Kill all panes
    for (const pane of panes) {
      if (pane) killPane(pane.paneId);
    }

    return allRoundResults;
  } catch (e: any) {
    for (const pane of panes) {
      if (pane) killPane(pane.paneId);
    }
    throw e;
  } finally {
    selectPane(mainPaneId);
    for (const pane of panes) {
      if (pane) try { fs.rmSync(pane.tmpDir, { recursive: true, force: true }); } catch {}
    }
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
