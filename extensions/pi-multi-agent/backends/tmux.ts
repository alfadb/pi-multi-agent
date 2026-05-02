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

/** Get the current (main) pane ID — call BEFORE any splits. */
async function getMainPaneId(): Promise<string> {
  try {
    const { stdout } = await execFileP("tmux", [
      "display-message", "-p", "#{pane_id}",
    ]);
    const id = stdout.trim();
    console.error(`[pi-multi-agent] Main pane ID: ${id}`);
    return id;
  } catch (e: any) {
    console.error(`[pi-multi-agent] Failed to get main pane ID: ${e.message}`);
    throw e;
  }
}

/** Select a specific pane, making it active. */
async function selectPane(paneId: string): Promise<void> {
  await execFileP("tmux", ["select-pane", "-t", paneId]);
}

/** Split a new pane from the main pane, run a command, return its ID.
 * Uses -P flag to print the new pane ID directly (avoids ambiguity). */
async function spawnPane(
  mainPaneId: string,
  label: string,
  command: string,
  index: number,
): Promise<TmuxPane> {
  // Always select main pane first so splits are from the right place
  await selectPane(mainPaneId);

  const safeCmd = command.replace(/'/g, `'\\''`);

  const args = [
    "split-window", "-P", "-F", "#{pane_id}",
    "-t", mainPaneId,
    ...(index === 0 ? ["-h", "-l", "80"] : ["-v", "-l", "15"]),
    "bash", "-c", safeCmd,
  ];

  const { stdout: paneId } = await execFileP("tmux", args);
  const newId = paneId.trim();
  console.error(`[pi-multi-agent] Spawned pane ${newId} for "${label}" (split from ${mainPaneId}, index=${index})`);

  if (index > 0) {
    try { await execFileP("tmux", ["select-layout", "tiled"]); } catch {}
  }

  // Select back to main pane so next split is from the right place
  await selectPane(mainPaneId);

  return { paneId: newId, label };
}

/** Kill a pane by ID. Never kills the main pane. */
async function killPane(paneId: string, mainPaneId: string, label?: string): Promise<void> {
  if (paneId === mainPaneId) {
    console.error(`[pi-multi-agent] Refusing to kill main pane ${mainPaneId} (task: ${label ?? "?"})`);
    return;
  }
  console.error(`[pi-multi-agent] Killing pane ${paneId} (task: ${label ?? "?"})`);
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
  // Escape API key for bash: wrap in single quotes, escape internal single quotes
  const safeKey = resolved.apiKey.replace(/'/g, `'\\''`);
  const envVars = `export ${resolved.provider.toUpperCase()}_API_KEY='${safeKey}'`;

  // Use absolute path to pi — new panes may not have the same PATH.
  // Detect at runtime from the main process's environment.
  const piPath = (() => {
    const paths = (process.env.PATH || "").split(":");
    for (const p of paths) {
      const candidate = path.join(p, "pi");
      try { if (fs.existsSync(candidate)) return candidate; } catch {}
    }
    return "pi"; // fallback
  })();

  const args = [
    "--model", `${resolved.provider}/${resolved.modelId}`,
    "--thinking", task.thinking,
    "--no-session",
    ...extraFlags,
  ];

  if (task.tools) args.push("--tools", task.tools);

  if (subMode === "print") {
    args.push("--print");
    return `${envVars} && ${piPath} ${args.join(" ")} < '${stdinFile}'`;
  } else {
    args.push("--mode", "rpc");
    return `${envVars} && ${piPath} ${args.join(" ")} < '${stdinFile}'`;
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

  // Save main pane ID BEFORE any splits
  const mainPaneId = await getMainPaneId();

  try {
    // Spawn panes
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const resolved = resolvedModels.get(task.id);
      if (!resolved) {
        results.push({
          taskId: task.id, model: task.model, role: task.role,
          output: "", error: `Model not found: ${task.model}`, durationMs: 0,
        });
        continue;
      }

      const promptFile = path.join(tmpDir, `${task.id}-prompt.md`);
      fs.writeFileSync(promptFile, task.prompt, "utf8");

      const piCmd = buildPiCmd(resolved, task, opts.extraFlags, "print", promptFile);
      const label = task.role ?? task.id;
      // TEMPORARY: test with simple echo to verify pane creation
      const fullCmd = `echo '=== START:${task.id} ===' && echo 'hello from pane' && sleep 3 && echo '' && echo '=== DONE:${task.id} ===' && read`;

      const pane = await spawnPane(mainPaneId, label, fullCmd, i);
      console.error(`[pi-multi-agent] Pane spawned: ${pane.paneId} for ${task.id}`);
      panes.push({ taskId: task.id, paneId: pane.paneId });
    }

    // Select back to main pane for safety
    await selectPane(mainPaneId);

    // Wait for all panes to complete
    for (const { taskId, paneId } of panes) {
      const task = tasks.find((t) => t.id === taskId)!;
      const marker = `=== DONE:${taskId} ===`;
      console.error("[pi-multi-agent] Waiting for marker..."); const raw = await waitForMarker(paneId, marker, opts.taskTimeoutMs);

      let output = "";
      let error: string | undefined;

      // null = real timeout, empty string = pane died with no output
      if (raw === null) {
        error = `Timed out after ${opts.taskTimeoutMs}ms`;
        // Try final capture from possibly-dead pane
        const final = await capturePane(paneId);
        output = final
          .replace(new RegExp(`=== START:${taskId} ===`, "g"), "")
          .replace(new RegExp(`=== DONE:${taskId} ===`, "g"), "")
          .replace(/Press Enter to close\.\.\./g, "")
          .trim();
      } else if (!raw.includes(marker)) {
        // Pane returned output but no marker — likely died early
        error = `Pane exited without DONE marker (captured ${raw.length} chars)`;
        output = raw
          .replace(new RegExp(`=== START:${taskId} ===`, "g"), "")
          .trim();
      } else {
        const startIdx = raw.indexOf(`=== START:${taskId} ===`);
        const endIdx = raw.indexOf(marker);
        if (startIdx !== -1 && endIdx !== -1) {
          output = raw.slice(startIdx + `=== START:${taskId} ===`.length, endIdx).trim();
        } else {
          output = raw.slice(0, raw.indexOf(marker)).trim();
        }
      }

      await killPane(paneId, mainPaneId, task.role ?? taskId);

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
    // Cleanup any remaining panes (should be none, but be safe)
    for (const entry of panes) {
      try { await killPane(entry.paneId, mainPaneId, entry.taskId); } catch {}
    }
    // Ensure we're back in main pane
    try { await selectPane(mainPaneId); } catch {}
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
  roundsPerTask: Map<string, string[]>,
  opts: TmuxBackendOptions,
): Promise<TaskResult[]> {
  const start = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ma-tmux-"));
  const panes: { taskId: string; paneId: string }[] = [];
  const results: TaskResult[] = [];

  const mainPaneId = await getMainPaneId();

  try {
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
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

      const piCmd = buildPiCmd(resolved, task, opts.extraFlags, "rpc", rpcFile);
      const label = task.role ?? task.id;
      const fullCmd =
        `echo '=== START:${task.id} ===' && ${piCmd} 2>/dev/null; ` +
        `echo ''; echo '=== DONE:${task.id} ==='; ` +
        `echo 'Press Enter to close...'; read`;

      const pane = await spawnPane(mainPaneId, label, fullCmd, i);
      panes.push({ taskId: task.id, paneId: pane.paneId });
    }

    await selectPane(mainPaneId);

    for (const { taskId, paneId } of panes) {
      const task = tasks.find((t) => t.id === taskId)!;
      const marker = `=== DONE:${taskId} ===`;
      const raw = await waitForMarker(paneId, marker, opts.taskTimeoutMs);

      let output = "";
      let error: string | undefined;

      // null = real timeout, non-null but no marker = pane died early
      if (raw === null) {
        error = `Timed out after ${opts.taskTimeoutMs}ms`;
        const final = await capturePane(paneId);
        output = final
          .replace(new RegExp(`=== START:${taskId} ===`, "g"), "")
          .replace(new RegExp(`=== DONE:${taskId} ===`, "g"), "")
          .trim();
      } else if (!raw.includes(marker)) {
        error = `Pane exited without DONE marker (captured ${raw.length} chars)`;
        output = raw.replace(new RegExp(`=== START:${taskId} ===`, "g"), "").trim();
      } else {
        const startIdx = raw.indexOf(`=== START:${taskId} ===`);
        const endIdx = raw.indexOf(marker);
        const body = startIdx !== -1 && endIdx !== -1
          ? raw.slice(startIdx + `=== START:${taskId} ===`.length, endIdx)
          : raw.slice(0, raw.indexOf(marker));

        const rounds = parseRpcOutput(body);
        output = rounds.length > 0
          ? rounds.map((r, j) => `## Round ${j + 1}\n\n${r}`).join("\n\n---\n\n")
          : body.trim();
      }

      await killPane(paneId, mainPaneId, task.role ?? taskId);

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
    for (const entry of panes) {
      try { await killPane(entry.paneId, mainPaneId, entry.taskId); } catch {}
    }
    try { await selectPane(mainPaneId); } catch {}
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
