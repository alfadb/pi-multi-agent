/**
 * Chain strategy — tasks execute sequentially, each receiving the previous output.
 * A→B→C: model A does work, model B reviews/extends, model C refines.
 */

import type {
  Task,
  TaskResult,
  DispatchOptions,
  ResolvedModel,
} from "../types.js";
import { executePrint } from "../backends/print.js";
import { executeRpc } from "../backends/rpc.js";

export async function executeChain(
  tasks: Task[],
  resolvedModels: Map<string, ResolvedModel>,
  opts: DispatchOptions & { timeoutMs: number; extraFlags: string[] },
): Promise<TaskResult[]> {
  const mode = opts.executionMode ?? "rpc";
  const executor = mode === "rpc" ? executeRpc : executePrint;

  const results: TaskResult[] = [];
  let previousOutput = "";

  for (const task of tasks) {
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

    // Build chain prompt: include previous step's output
    let chainPrompt = task.prompt;
    if (previousOutput && results.length > 0) {
      const prev = results[results.length - 1];
      chainPrompt = [
        task.prompt,
        "",
        "---",
        `## Previous step (${prev.role ?? prev.taskId}, ${prev.model})`,
        prev.output,
        "",
        "Build on or refine the above output.",
      ].join("\n");
    }

    const chainTask: Task = { ...task, prompt: chainPrompt };
    const result = await executor(chainTask, resolved, {
      taskTimeoutMs: opts.timeoutMs,
      extraFlags: opts.extraFlags,
    });

    results.push(result);
    previousOutput = result.output;
  }

  return results;
}
