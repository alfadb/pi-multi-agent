/**
 * Parallel strategy — all tasks execute concurrently, results merged.
 */

import type {
  Task,
  TaskResult,
  DispatchOptions,
  ResolvedModel,
} from "../types.js";
import { executePrint } from "../backends/print.js";
import { executeRpc } from "../backends/rpc.js";

export async function executeParallel(
  tasks: Task[],
  resolvedModels: Map<string, ResolvedModel>,
  opts: DispatchOptions & { timeoutMs: number; extraFlags: string[] },
): Promise<TaskResult[]> {
  const mode = opts.executionMode ?? "print";
  const executor = mode === "rpc" ? executeRpc : executePrint;

  const jobs = tasks.map((task) => {
    const resolved = resolvedModels.get(task.id);
    if (!resolved) {
      return Promise.resolve({
        taskId: task.id,
        model: task.model,
        role: task.role,
        output: "",
        error: `Model not found: ${task.model}`,
        durationMs: 0,
      } satisfies TaskResult);
    }
    return executor(task, resolved, {
      taskTimeoutMs: opts.timeoutMs,
      extraFlags: opts.extraFlags,
    });
  });

  return Promise.all(jobs);
}
