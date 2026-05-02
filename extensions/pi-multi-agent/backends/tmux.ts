/**
 * Tmux backend — splits panes so sub-agents are visible in real-time.
 *
 * Two sub-modes:
 *   tmux+print — pi --print for single-turn tasks (parallel/ensemble)
 *   tmux+rpc   — pi --mode rpc for multi-turn tasks (debate/chain)
 *
 * Each task gets its own pane. The user sees streaming output, thinking,
 * and tool calls in real-time. Results are captured via capture-pane.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type { Task, TaskResult, ResolvedModel } from "../types.js";

const execFileP = promisify(execFile);

export interface TmuxBackendOptions {
  taskTimeoutMs: number;
  extraFlags: string[];
}

// ── Low-level tmux helpers ──────────────────────────────────────

interface TmuxPane {
  paneId: string;
  label: string;
}

/** Split a new pane, run a command, return its ID. */
async function spawnPane(
  label: string,
  command: string,
  isFirst: boolean,
): Promise<TmuxPane> {
  // Escape single quotes in command for bash -c
  const safeCmd = command.replace(/'/g, `'\\''`);

  if (isFirst) {
    await execFileP("tmux", [
      "split-window", "-h", "-l", "80",
      "bash", "-c", safeCmd,
    ]);
  } else {
    await execFileP("tmux", [
      "split-window", "-v", "-l", "15",
      "bash", "-c", safeCmd,
    ]);
    try { await execFileP("tmux", ["select-layout", "tiled"]); } catch {}
  }

  const { stdout: paneId } = await execFileP("tmux", [
    "display-message", "-p", "#{pane_id}",
  ]);
  return { paneId: paneId.trim(), label };
}

/** Kill a pane by ID. */
async function killPane(paneId: string): Promise<void> {
  try { await execFileP("tmux", ["kill-pane", "-t", paneId]); } catch {}
}

/** Capture the visible content of a pane. */
async function capturePane(paneId: string): Promise<string> {
  try {
    const { stdout } = await execFileP("tmux", [
      "capture-pane", "-t", paneId, "-p", "-S", "-",
    ]);
    return stdout;
  } catch {
    return "";
  }
}

/** Check if a pane is still alive. */
async function paneAlive(paneId: string): Promise<boolean> {
  try {
    await execFileP("tmux", ["capture-pane", "-t", paneId, "-p"]);
    return true;
  } catch {
    return false;
  }
}

/** Poll until a marker appears in pane output or timeout. */
async function waitForMarker(
  paneId: string,
  marker: string,
  timeoutMs: number,
  pollMs: number = 2000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!(await paneAlive(paneId))) {
      // Pane died — capture final output
      const out = await capturePane(paneId);
      return out;
    }

    const out = await capturePane(paneId);
    if (out.includes(marker)) {
      return out;
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  return null; // timeout
}

/** Build a pi command line for a task. */
function buildPiCmd(
  resolved: ResolvedModel,
  task: Task,
  extraFlags: string[],
  subMode: "print" | "rpc",
  stdinFile?: string,
): string {
  const envVars = `export ${resolved.provider.toUpperCase()}_API_KEY="${resolved.apiKey}"`;

  const args = [
    "--model", `${resolved.provider}/${resolved.modelId}`,
    "--thinking", task.thinking,
    "--no-session",
    ...extraFlags,
  ];

  if (task.tools) args.push("--tools", task.tools);

  if (subMode === "print") {
    args.push("--print");
    return `${envVars} && pi ${args.join(" ")} < '${stdinFile}'`;
  } else {
    args.push("--mode", "rpc");
    return `${envVars} && pi ${args.join(" ")} < '${stdinFile}'`;
  }
}

// ── Multi-turn RPC context ──────────────────────────────────────

/** Pre-baked RPC commands for a multi-turn task. */
interface RpcRound {
  /** Prompt for this round (already formatted with debate/chain context). */
  prompt: string;
}

/**
 * Build a JSONL file with all RPC commands for a multi-turn task.
 * Returns the path to the file.
 */
function buildRpcCommandFile(
  taskId: string,
  rounds: RpcRound[],
  tmpDir: string,
): string {
  const file = path.join(tmpDir, `${taskId}-rpc-commands.jsonl`);
  const lines: string[] = [];

  for (const round of rounds) {
    // Escape special JSON chars
    const escaped = JSON.stringify(round.prompt);

    // RPC prompt command — send, wait for agent_end, next round
    // We use follow_up mode: each prompt is queued after previous completes
    const cmd = rounds.indexOf(round) === 0
      ? JSON.stringify({ type: "prompt", message: round.prompt })
      : JSON.stringify({ type: "prompt", message: round.prompt, streamingBehavior: "followUp" });

    lines.push(cmd);
  }

  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

/**
 * Parse RPC output (JSONL events) to extract text from all rounds.
 */
function parseRpcOutput(raw: string): string[] {
  const lines = raw.split("\n");
  const rounds: string[] = [];
  let currentRound = "";
  let inAgent = false;

  for (const line of lines) {
    if (!line.trim()) continue;

    // Some lines may be non-JSON (banner, stderr noise)
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }

    if (event.type === "agent_start") {
      inAgent = true;
      currentRound = "";
    }

    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (delta?.type === "text_delta" && delta.delta) {
        currentRound += delta.delta;
      }
    }

    if (event.type === "agent_end" && inAgent) {
      // Also extract from messages if no streaming text captured
      if (!currentRound && event.messages?.length) {
        for (const msg of event.messages) {
          if (msg.role === "assistant" && msg.content) {
            for (const block of msg.content) {
              if (block.type === "text") currentRound += block.text;
            }
          }
        }
      }
      rounds.push(currentRound.trim());
      inAgent = false;
    }
  }

  return rounds;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Execute tasks via tmux+print (single-turn).
 * Each pane runs `pi --print`, output captured via marker polling.
 */
export async function executeTmuxPrint(
  tasks: Task[],
  resolvedModels: Map<string, ResolvedModel>,
  opts: TmuxBackendOptions,
): Promise<TaskResult[]> {
  const start = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ma-tmux-"));
  const panes: { taskId: string; paneId: string }[] = [];
  const results: TaskResult[] = [];

  try {
    // Spawn panes
    let isFirst = true;

    for (const task of tasks) {
      const resolved = resolvedModels.get(task.id);
      if (!resolved) {
        results.push({
          taskId: task.id, model: task.model, role: task.role,
          output: "", error: `Model not found: ${task.model}`, durationMs: 0,
        });
        continue;
      }

      // Write prompt file
      const promptFile = path.join(tmpDir, `${task.id}-prompt.md`);
      fs.writeFileSync(promptFile, task.prompt, "utf8");

      // Build command with completion marker
      const piCmd = buildPiCmd(resolved, task, opts.extraFlags, "print", promptFile);
      const label = task.role ?? task.id;
      const fullCmd = `echo '=== START:${task.id} ===' && ${piCmd}; echo ''; echo '=== DONE:${task.id} ==='; echo 'Press Enter to close...'; read`;

      const pane = await spawnPane(label, fullCmd, isFirst);
      panes.push({ taskId: task.id, paneId: pane.paneId });
      isFirst = false;
    }

    // Wait for all panes to complete
    for (const { taskId, paneId } of panes) {
      const task = tasks.find((t) => t.id === taskId)!;
      const marker = `=== DONE:${taskId} ===`;
      const raw = await waitForMarker(paneId, marker, opts.taskTimeoutMs);

      let output = "";
      let error: string | undefined;

      if (raw) {
        const startIdx = raw.indexOf(`=== START:${taskId} ===`);
        const endIdx = raw.indexOf(marker);
        if (startIdx !== -1 && endIdx !== -1) {
          output = raw.slice(startIdx + `=== START:${taskId} ===`.length, endIdx).trim();
        } else {
          output = raw.slice(0, raw.indexOf(marker)).trim();
        }
      } else {
        error = `Timed out after ${opts.taskTimeoutMs}ms`;
        // Try final capture
        const final = await capturePane(paneId);
        output = final
          .replace(new RegExp(`=== START:${taskId} ===`, "g"), "")
          .replace(new RegExp(`=== DONE:${taskId} ===`, "g"), "")
          .replace(/Press Enter to close\.\.\./g, "")
          .trim();
      }

      await killPane(paneId);

      results.push({
        taskId: task.id,
        model: task.model,
        role: task.role,
        output,
        error,
        durationMs: Date.now() - start,
      });
    }

    return results;
  } finally {
    // Cleanup any remaining panes
    for (const { paneId } of panes) {
      try { await killPane(paneId); } catch {}
    }
    try { await execFileP("tmux", ["select-pane", "-t", "0"]); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Execute a multi-turn task via tmux+rpc.
 * Each task gets a pane with `pi --mode rpc`. Multi-turn prompts are
 * pre-baked into a JSONL file and processed sequentially.
 *
 * Returns output per round as separate entries.
 */
export async function executeTmuxRpc(
  tasks: Task[],
  resolvedModels: Map<string, ResolvedModel>,
  roundsPerTask: Map<string, string[]>, // taskId → round prompts
  opts: TmuxBackendOptions,
): Promise<TaskResult[]> {
  const start = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ma-tmux-"));
  const panes: { taskId: string; paneId: string }[] = [];
  const results: TaskResult[] = [];

  try {
    let isFirst = true;

    for (const task of tasks) {
      const resolved = resolvedModels.get(task.id);
      if (!resolved) {
        results.push({
          taskId: task.id, model: task.model, role: task.role,
          output: "", error: `Model not found: ${task.model}`, durationMs: 0,
        });
        continue;
      }

      const roundPrompts = roundsPerTask.get(task.id) ?? [task.prompt];
      const rpcRounds: RpcRound[] = roundPrompts.map((p) => ({ prompt: p }));
      const rpcFile = buildRpcCommandFile(task.id, rpcRounds, tmpDir);

      // Build command: run pi in RPC mode, capture all output
      const piCmd = buildPiCmd(resolved, task, opts.extraFlags, "rpc", rpcFile);
      const label = task.role ?? task.id;
      const fullCmd =
        `echo '=== START:${task.id} ===' && ${piCmd} 2>/dev/null; ` +
        `echo ''; echo '=== DONE:${task.id} ==='; ` +
        `echo 'Press Enter to close...'; read`;

      const pane = await spawnPane(label, fullCmd, isFirst);
      panes.push({ taskId: task.id, paneId: pane.paneId });
      isFirst = false;
    }

    // Wait for all panes, parse multi-round output
    for (const { taskId, paneId } of panes) {
      const task = tasks.find((t) => t.id === taskId)!;
      const marker = `=== DONE:${taskId} ===`;
      const raw = await waitForMarker(paneId, marker, opts.taskTimeoutMs);

      let output = "";
      let error: string | undefined;

      if (raw) {
        const startIdx = raw.indexOf(`=== START:${taskId} ===`);
        const endIdx = raw.indexOf(marker);
        const body = startIdx !== -1 && endIdx !== -1
          ? raw.slice(startIdx + `=== START:${taskId} ===`.length, endIdx)
          : raw.slice(0, raw.indexOf(marker));

        // Parse RPC events to extract multi-round output
        const rounds = parseRpcOutput(body);
        output = rounds.length > 0
          ? rounds.map((r, i) => `## Round ${i + 1}\n\n${r}`).join("\n\n---\n\n")
          : body.trim();
      } else {
        error = `Timed out after ${opts.taskTimeoutMs}ms`;
        const final = await capturePane(paneId);
        output = final
          .replace(new RegExp(`=== START:${taskId} ===`, "g"), "")
          .replace(new RegExp(`=== DONE:${taskId} ===`, "g"), "")
          .trim();
      }

      await killPane(paneId);

      results.push({
        taskId: task.id,
        model: task.model,
        role: task.role,
        output,
        error,
        durationMs: Date.now() - start,
      });
    }

    return results;
  } finally {
    for (const { paneId } of panes) {
      try { await killPane(paneId); } catch {}
    }
    try { await execFileP("tmux", ["select-pane", "-t", "0"]); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Execute all tasks in parallel tmux panes, auto-selecting print or rpc
 * based on whether multi-turn rounds are provided.
 */
export async function executeTmux(
  tasks: Task[],
  resolvedModels: Map<string, ResolvedModel>,
  opts: TmuxBackendOptions,
  roundsPerTask?: Map<string, string[]>,
): Promise<TaskResult[]> {
  if (roundsPerTask && roundsPerTask.size > 0) {
    return executeTmuxRpc(tasks, resolvedModels, roundsPerTask, opts);
  }
  return executeTmuxPrint(tasks, resolvedModels, opts);
}

/**
 * Check if tmux is available.
 */
export async function isTmuxAvailable(): Promise<boolean> {
  try {
    const inTmux = !!process.env.TMUX;
    if (!inTmux) return false;
    await execFileP("tmux", ["display-message", "-p", "#{pane_id}"]);
    return true;
  } catch {
    return false;
  }
}
