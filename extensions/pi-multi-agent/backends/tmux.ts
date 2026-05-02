/**
 * Tmux backend — splits panes so sub-agents are visible in real-time.
 * Best for debugging, demos, and when you want to watch the models think.
 *
 * Each task gets its own tmux pane. The pane runs `pi --print`, output is
 * captured via `tmux capture-pane` after completion.
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

/**
 * Execute tasks in parallel tmux panes.
 * Splits panes, sends pi commands, waits for completion, captures output.
 */
export async function executeTmux(
  tasks: Task[],
  resolvedModels: Map<string, ResolvedModel>,
  opts: TmuxBackendOptions,
): Promise<TaskResult[]> {
  const start = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ma-tmux-"));
  const results: TaskResult[] = [];

  try {
    // Write prompt files for each task
    const paneIds: string[] = [];
    const promptFiles: string[] = [];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const resolved = resolvedModels.get(task.id);
      if (!resolved) {
        results.push({
          taskId: task.id,
          model: task.model,
          role: task.role,
          output: "",
          error: `Model not found: ${task.model}`,
          durationMs: 0,
        });
        continue;
      }

      const promptFile = path.join(tmpDir, `${task.id}-prompt.md`);
      fs.writeFileSync(promptFile, task.prompt, "utf8");
      promptFiles.push(promptFile);

      // Build pi command
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

      const envVars = `export ${resolved.provider.toUpperCase()}_API_KEY="${resolved.apiKey}"`;
      const piCmd = `${envVars} && pi ${args.join(" ")} < ${promptFile}`;

      // Split pane and run command
      if (i === 0) {
        // First task: split right from current pane
        await execFileP("tmux", [
          "split-window", "-h",
          "-l", "80",
          `bash -c '${piCmd}; echo "=== DONE:${task.id} ==="; read'`,
        ]);
      } else {
        // Subsequent tasks: split below from the previous pane
        // Get the last pane ID, split from it
        await execFileP("tmux", [
          "split-window", "-v",
          "-l", "15",
          `bash -c '${piCmd}; echo "=== DONE:${task.id} ==="; read'`,
        ]);
        // Re-layout to keep it readable
        try {
          await execFileP("tmux", ["select-layout", "tiled"]);
        } catch {}
      }

      // Get the new pane's ID
      const { stdout: paneId } = await execFileP("tmux", [
        "display-message", "-p", "#{pane_id}",
      ]);
      paneIds.push(paneId.trim());
    }

    // Wait for all panes to complete (poll for "DONE:taskId" markers)
    const remaining = new Set(tasks.map((t) => t.id));
    const taskOutputs = new Map<string, string>();
    const deadline = Date.now() + opts.taskTimeoutMs;

    while (remaining.size > 0 && Date.now() < deadline) {
      for (const task of tasks) {
        if (!remaining.has(task.id)) continue;

        const taskIndex = tasks.findIndex((t) => t.id === task.id);
        const paneId = paneIds[taskIndex];
        if (!paneId) {
          remaining.delete(task.id);
          continue;
        }

        try {
          const { stdout } = await execFileP("tmux", [
            "capture-pane", "-t", paneId, "-p", "-S", "-",
          ]);
          if (stdout.includes(`=== DONE:${task.id} ===`)) {
            // Extract the output (everything before the DONE marker)
            const markerIdx = stdout.indexOf(`=== DONE:${task.id} ===`);
            const output = stdout.slice(0, markerIdx).trim();
            taskOutputs.set(task.id, output);
            remaining.delete(task.id);

            // Kill the pane
            try {
              await execFileP("tmux", ["kill-pane", "-t", paneId]);
            } catch {}
          }
        } catch {
          // Pane may have died, check if it's still alive
          try {
            await execFileP("tmux", ["capture-pane", "-t", paneId, "-p"]);
          } catch {
            // Pane is gone, assume it completed
            try {
              const { stdout: lastCapture } = await execFileP("tmux", [
                "capture-pane", "-t", paneId, "-p", "-S", "-",
              ]);
              taskOutputs.set(task.id, lastCapture.trim());
            } catch {}
            remaining.delete(task.id);
          }
        }
      }

      if (remaining.size > 0) {
        await new Promise((r) => setTimeout(r, 2000)); // Poll every 2s
      }
    }

    // Build results
    for (const task of tasks) {
      const resolved = resolvedModels.get(task.id);
      if (!resolved) continue;

      const output = taskOutputs.get(task.id);
      if (output !== undefined) {
        results.push({
          taskId: task.id,
          model: task.model,
          role: task.role,
          output,
          durationMs: Date.now() - start,
        });
      } else if (remaining.has(task.id)) {
        results.push({
          taskId: task.id,
          model: task.model,
          role: task.role,
          output: "",
          error: `Timed out after ${opts.taskTimeoutMs}ms`,
          durationMs: Date.now() - start,
        });
      }
    }

    // Cleanup: kill any remaining panes
    for (const paneId of paneIds) {
      try { await execFileP("tmux", ["kill-pane", "-t", paneId]); } catch {}
    }

    // Select back to main pane
    try {
      await execFileP("tmux", ["select-pane", "-t", "0"]);
    } catch {}

    return results;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Check if tmux is available.
 */
export async function isTmuxAvailable(): Promise<boolean> {
  try {
    // Check if we're inside tmux AND tmux binary is available
    const inTmux = !!process.env.TMUX;
    if (!inTmux) return false;

    await execFileP("tmux", ["display-message", "-p", "#{pane_id}"]);
    return true;
  } catch {
    return false;
  }
}
