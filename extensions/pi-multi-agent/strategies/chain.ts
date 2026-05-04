/**
 * Chain strategy — tasks execute sequentially, each receiving the previous output.
 * A→B→C: model A does work, model B reviews/extends, model C refines.
 * SDK-only: each step is an in-process completeSimple call via runTask.
 */

import type { DispatchOptions, ResolvedModel, Task, TaskResult } from "../types.js";
import { runTask, type RunnerCtx } from "../runner.js";

export async function executeChain(
  tasks: Task[],
  resolvedModels: Map<string, ResolvedModel>,
  rctx: RunnerCtx,
  _opts: DispatchOptions,
): Promise<TaskResult[]> {
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

    // Build chain prompt: include previous step's output.
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
    const result = await runTask(chainTask, resolved, rctx);
    results.push(result);
    previousOutput = result.output;
  }

  return results;
}
