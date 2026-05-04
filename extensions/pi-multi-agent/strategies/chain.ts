/**
 * Chain strategy — tasks execute sequentially, each receiving the previous output.
 * A→B→C: model A does work, model B reviews/extends, model C refines.
 * SDK-only: each step is an in-process completeSimple call via runTask.
 */

import type { DispatchOptions, ResolvedModel, Task, TaskResult } from "../types.js";
import { runTask, missingModelResult, type RunnerCtx } from "../runner.js";

export async function executeChain(
  tasks: Task[],
  resolvedModels: Map<string, ResolvedModel>,
  rctx: RunnerCtx,
  _opts: DispatchOptions,
): Promise<TaskResult[]> {
  const results: TaskResult[] = [];
  let previousOutput = "";

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const resolved = resolvedModels.get(task.id);

    // Compute this step's result (either a missing-model placeholder or a
    // real LLM call). Either path produces a TaskResult — unified handling
    // below ensures fail-fast triggers regardless of source.
    let result: TaskResult;
    if (!resolved) {
      result = missingModelResult(task);
    } else {
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
      result = await runTask(chainTask, resolved, rctx);
    }
    results.push(result);
    previousOutput = result.output;

    // Fail-fast: chain semantics require each step to build on the previous.
    // If a step errored (or produced empty output), continuing would feed
    // garbage downstream and burn tokens. Stop here; subsequent tasks are
    // pushed as skipped results so the report shows what didn't run and why.
    if (result.error || !result.output.trim()) {
      const reason = result.error
        ? `chain stopped: step '${task.id}' errored (${result.error.slice(0, 80)})`
        : `chain stopped: step '${task.id}' produced empty output`;
      for (let j = i + 1; j < tasks.length; j++) {
        const skipped = tasks[j];
        results.push({
          taskId: skipped.id,
          model: skipped.model,
          role: skipped.role,
          output: "",
          error: reason,
          durationMs: 0,
        });
      }
      break;
    }
  }

  return results;
}
