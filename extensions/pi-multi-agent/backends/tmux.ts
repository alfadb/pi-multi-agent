/**
 * Tmux backend — spawns tasks in separate tmux windows (pi-side-agents pattern).
 *
 * Uses `tmux new-window -d` to create background windows. Each task runs
 * `pi --print` in its own named window. Output is piped to a log file and
 * collected via `tmux capture-pane`. Windows are killed after collection.
 *
 * Sub-modes:
 *   tmux+print — pi --print for single-turn tasks
 *   tmux+rpc   — pi --mode rpc for multi-turn tasks (via pre-baked JSONL)
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

// ── Tmux primitives (sync — pi-side-agents uses spawnSync) ──────

function tmux(args: string[], input?: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const result = execFileSync("tmux", args, {
      input,
      encoding: "utf8",
      timeout: 30_000,
    });
    return { ok: true, stdout: result, stderr: "" };
  } catch (e: any) {
    return {
      ok: false,
      stdout: e?.stdout ?? "",
      stderr: e?.stderr ?? e?.message ?? String(e),
    };
  }
}

function tmuxOrThrow(args: string[], input?: string): string {
  const result = tmux(args, input);
  if (!result.ok) {
    throw new Error(`tmux ${args[0]} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function getCurrentSession(): string {
  return tmuxOrThrow(["display-message", "-p", "#S"]).trim();
}

function createWindow(session: string, name: string): { windowId: string; windowIndex: number } {
  const out = tmuxOrThrow([
    "new-window", "-d", "-t", `${session}:`,
    "-P", "-F", "#{window_id} #{window_index}",
    "-n", name,
  ]).trim();
  const [windowId, indexRaw] = out.split(/\s+/);
  return { windowId, windowIndex: Number(indexRaw) };
}

function pipePaneToFile(windowId: string, logPath: string): void {
  tmuxOrThrow(["pipe-pane", "-t", windowId, "-o", `cat >> ${logPath}`]);
}

function capturePane(windowId: string): string {
  const result = tmux(["capture-pane", "-p", "-t", windowId, "-S", "-", "-E", "-"]);
  return result.ok ? result.stdout : "";
}

function sendKeys(windowId: string, keys: string): void {
  tmuxOrThrow(["send-keys", "-t", windowId, keys, "C-m"]);
}

function killWindow(windowId: string): void {
  tmux(["kill-window", "-t", windowId]);
}

function windowExists(windowId: string): boolean {
  const result = tmux(["display-message", "-p", "-t", windowId, "#{window_id}"]);
  return result.ok && result.stdout.trim() === windowId;
}

// ── Shell escaping ──────────────────────────────────────────────

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

// ── Task execution ──────────────────────────────────────────────

interface RpcRound {
  prompt: string;
}

function buildRpcCommandFile(taskId: string, rounds: RpcRound[], tmpDir: string): string {
  const file = path.join(tmpDir, `${taskId}-rpc-commands.jsonl`);
  const lines = rounds.map((r, i) => {
    if (i === 0) return JSON.stringify({ type: "prompt", message: r.prompt });
    return JSON.stringify({ type: "prompt", message: r.prompt, streamingBehavior: "followUp" });
  });
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

function findPiPath(): string {
  const paths = (process.env.PATH || "").split(":");
  for (const p of paths) {
    const candidate = path.join(p, "pi");
    try { if (fs.existsSync(candidate)) return candidate; } catch {}
  }
  return "pi";
}

function buildLaunchScript(
  task: Task,
  piPath: string,
  promptFile: string,
  exitFile: string,
  subMode: "print" | "rpc",
  extraFlags: string[],
): string {
  const modelArg = shellQuote(`--model=${task.model}`);

  const args = [
    piPath,
    modelArg,
    `--thinking=${task.thinking}`,
    "--no-session",
    ...extraFlags,
  ];

  if (task.tools) args.push(`--tools=${shellQuote(task.tools)}`);

  if (subMode === "print") {
    args.push("--print");
  } else {
    args.push("--mode=rpc");
  }

  const piCmd = args.join(" ");

  return `#!/usr/bin/env bash
set -euo pipefail
${piCmd} < ${shellQuote(promptFile)}
EXIT=$?
echo '{"exitCode":'$EXIT',"finishedAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > ${shellQuote(exitFile)}
if [ $EXIT -eq 0 ]; then echo "[pi-ma] DONE:${task.id}"; else echo "[pi-ma] ERROR:${task.id} code=$EXIT"; fi
read -n 1 -s -r -p "[pi-ma] Press any key..." || true
echo
tmux kill-window -t "${shellQuote(task.id)}" 2>/dev/null || true
`;
}

function parseExitFile(exitFile: string): { exitCode?: number; finishedAt?: string } | null {
  try {
    const raw = fs.readFileSync(exitFile, "utf8").trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Execute a single task in a tmux window.
 */
async function executeOneInTmux(
  task: Task,
  opts: TmuxBackendOptions,
  subMode: "print" | "rpc",
  rounds?: string[],
): Promise<TaskResult> {
  const start = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ma-tmux-"));
  const promptFile = path.join(tmpDir, "prompt.md");
  const exitFile = path.join(tmpDir, "exit.json");
  const logPath = path.join(tmpDir, "output.log");
  const launchScriptPath = path.join(tmpDir, "launch.sh");

  try {
    // Build prompt
    const prompt = rounds
      ? rounds.map((r, i) => `## Round ${i + 1}\n\n${r}`).join("\n\n---\n\n")
      : task.prompt;
    fs.writeFileSync(promptFile, prompt, "utf8");

    // If multi-turn RPC, pre-bake commands
    let actualPromptFile = promptFile;
    let actualSubMode = subMode;
    if (subMode === "rpc" && rounds && rounds.length > 1) {
      actualPromptFile = buildRpcCommandFile(task.id, rounds.map((p) => ({ prompt: p })), tmpDir);
      actualSubMode = "rpc";
    }

    // Build launch script
    const piPath = findPiPath();
    const launchScript = buildLaunchScript(
      task, piPath, actualPromptFile, exitFile, actualSubMode, opts.extraFlags,
    );
    fs.writeFileSync(launchScriptPath, launchScript, "utf8");
    fs.chmodSync(launchScriptPath, 0o755);

    // Create tmux window in background
    const session = getCurrentSession();
    const windowName = task.role ?? task.id;
    const { windowId } = createWindow(session, windowName);

    // Pipe output to log file
    pipePaneToFile(windowId, logPath);

    // Send the launch command
    sendKeys(windowId, `bash ${shellQuote(launchScriptPath)}`);

    // Poll for completion
    const deadline = Date.now() + opts.taskTimeoutMs;
    let output = "";
    let error: string | undefined;

    while (Date.now() < deadline) {
      // Check exit file
      const exit = parseExitFile(exitFile);
      if (exit) {
        // Task finished — capture all output
        output = stripNoise(capturePane(windowId));
        if (exit.exitCode !== 0) {
          error = `Task exited with code ${exit.exitCode}`;
        }
        killWindow(windowId);
        break;
      }

      // Check if window still exists
      if (!windowExists(windowId)) {
        // Window died unexpectedly — try to get log output
        try { output = fs.readFileSync(logPath, "utf8"); } catch {}
        output = stripNoise(output);
        error = "Tmux window died unexpectedly";
        break;
      }

      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!output && !error) {
      error = `Timed out after ${opts.taskTimeoutMs}ms`;
      try { output = fs.readFileSync(logPath, "utf8"); } catch {}
      output = stripNoise(output);
      killWindow(windowId);
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

function stripNoise(text: string): string {
  // Strip ANSI escape sequences and common TUI noise
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\[pi-ma\] (DONE|ERROR):[^\n]*\n?/g, "")
    .replace(/Press any key\.\.\./g, "")
    .trim();
}

// ── Public API ──────────────────────────────────────────────────

export async function executeTmux(
  tasks: Task[],
  resolvedModels: Map<string, ResolvedModel>,
  opts: TmuxBackendOptions,
  roundsPerTask?: Map<string, string[]>,
): Promise<TaskResult[]> {
  console.error(`[pi-multi-agent] executeTmux called with ${tasks.length} tasks, models: ${[...resolvedModels.keys()].join(", ")}`);
  const jobs = tasks.map((task) => {
    const rounds = roundsPerTask?.get(task.id);
    return executeOneInTmux(task, opts, rounds ? "rpc" : "print", rounds);
  });
  return Promise.all(jobs);
}

export async function isTmuxAvailable(): Promise<boolean> {
  try {
    // Minimal test: create and kill a window
    const session = tmuxOrThrow(["display-message", "-p", "#S"]).trim();
    const testName = `pi-ma-test-${Date.now()}`;
    const out = tmuxOrThrow([
      "new-window", "-d", "-t", `${session}:`,
      "-P", "-F", "#{window_id}",
      "-n", testName,
      "echo", "hello from tmux; sleep 3",
    ]);
    const windowId = out.trim();
    console.error(`[pi-multi-agent] Test window created: ${windowId}`);
    await new Promise((r) => setTimeout(r, 1000));
    tmux(["kill-window", "-t", windowId]);
    console.error(`[pi-multi-agent] Test window killed: ${windowId}`);
    return true;
  } catch (e: any) {
    console.error(`[pi-multi-agent] Tmux test failed: ${e.message}`);
    return false;
  }
}
