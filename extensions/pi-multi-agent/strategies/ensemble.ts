/**
 * Ensemble strategy — all models answer the same question independently,
 * then a synthesis model picks the best answer or builds consensus.
 * SDK-only: tasks dispatch in parallel via runTask, then a synthesis task runs.
 */

import type { DispatchOptions, ResolvedModel, Task, TaskResult } from "../types.js";
import { runTask, type RunnerCtx } from "../runner.js";

export async function executeEnsemble(
  tasks: Task[],
  resolvedModels: Map<string, ResolvedModel>,
  rctx: RunnerCtx,
  opts: DispatchOptions,
): Promise<{ taskResults: TaskResult[]; synthesis: string }> {
  // All models answer the same prompt independently (Promise.all).
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

  const taskResults = await Promise.all(jobs);

  // Synthesis pass — pick best or build consensus.
  const synthesisModel = opts.synthesisModel ?? tasks[0].model;
  const synthesisResolved =
    resolvedModels.get("__synthesis__") ?? resolvedModels.get(tasks[0].id);
  if (!synthesisResolved) {
    return { taskResults, synthesis: "Synthesis failed: no model resolvable" };
  }

  const responses = taskResults
    .filter((r) => !r.error)
    .map(
      (r, i) =>
        `### Response ${i + 1}: ${r.role ?? r.taskId} (${r.model})\n\n${r.output}`,
    )
    .join("\n\n---\n\n");

  const synthesisPrompt = [
    "You are evaluating multiple independent responses to the same prompt.",
    "Your job:",
    "1. Identify where responses agree → this is high-confidence",
    "2. Identify where responses disagree → explain each position",
    "3. Pick the best response, or synthesize a better answer from elements of several",
    "4. Provide your final answer with clear reasoning",
    "",
    "## Original Prompt",
    tasks[0]?.prompt ?? "",
    "",
    "## Responses",
    responses,
    "",
    "---",
    "## Your Synthesis",
  ].join("\n");

  const synthesisTask: Task = {
    id: "__synthesis__",
    model: synthesisModel,
    thinking: opts.synthesisThinking ?? "high",
    prompt: synthesisPrompt,
  };

  const synthesisResult = await runTask(synthesisTask, synthesisResolved, rctx);

  return {
    taskResults,
    synthesis: synthesisResult.error
      ? `Synthesis failed: ${synthesisResult.error}`
      : synthesisResult.output,
  };
}
