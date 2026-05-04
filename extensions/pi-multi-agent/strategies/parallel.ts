/**
 * Parallel strategy — all tasks execute concurrently, results merged.
 * SDK-only: each task is an in-process completeSimple call via runTask.
 */

import type { DispatchOptions, ResolvedModel, Task, TaskResult } from "../types.js";
import { runTask, type RunnerCtx } from "../runner.js";

export async function executeParallel(
  tasks: Task[],
  resolvedModels: Map<string, ResolvedModel>,
  rctx: RunnerCtx,
  _opts: DispatchOptions,
): Promise<TaskResult[]> {
  const jobs = tasks.map((task) => {
    const resolved = resolvedModels.get(task.id);
    if (!resolved) {
      return Promise.resolve<TaskResult>({
        taskId: task.id,
        model: task.model,
        role: task.role,
        output: "",
        error: `Model not found: ${task.model}`,
        durationMs: 0,
      });
    }
    return runTask(task, resolved, rctx);
  });

  return Promise.all(jobs);
}
