/**
 * Debate strategy — N models discuss a topic over multiple rounds.
 * Round 1: all models respond independently.
 * Rounds 2..N: each model reads others' previous-round responses and responds.
 * Final: synthesis model summarizes the debate.
 *
 * SDK-only: each turn is an in-process completeSimple call via runTask.
 * Note: no in-process state is shared between rounds — each round is a fresh
 * runTask call with a freshly-built prompt that embeds prior responses.
 */

import type { DispatchOptions, ResolvedModel, Task, TaskResult } from "../types.js";
import { runTask, missingModelResult, type RunnerCtx } from "../runner.js";

export async function executeDebate(
  tasks: Task[],
  resolvedModels: Map<string, ResolvedModel>,
  rctx: RunnerCtx,
  opts: DispatchOptions,
): Promise<{ taskResults: TaskResult[]; synthesis: string }> {
  const rounds = opts.debateRounds ?? 2;

  // roundResults[r] is a map: taskId → full TaskResult for round r.
  // Storing TaskResult (not just text) lets us accumulate durationMs across
  // rounds and surface per-round error info — important for diagnosing why a
  // particular debater dropped out mid-debate.
  const roundResults: Map<string, TaskResult>[] = [];

  // Round 1: independent responses.
  const r1Jobs = tasks.map(async (task) => {
    const resolved = resolvedModels.get(task.id);
    if (!resolved) return missingModelResult(task);
    return runTask(task, resolved, rctx);
  });
  const r1Results = await Promise.all(r1Jobs);
  roundResults.push(new Map(tasks.map((t, i) => [t.id, r1Results[i]])));

  // Rounds 2..N: cross-response.
  for (let r = 2; r <= rounds; r++) {
    const previousRound = roundResults[r - 2];
    const roundJobs = tasks.map(async (task, idx) => {
      const resolved = resolvedModels.get(task.id);
      if (!resolved) return missingModelResult(task);

      const othersResponses = tasks
        .filter((_, j) => j !== idx)
        .map((other) => {
          const prev = previousRound.get(other.id);
          const resp = prev?.output || "(no response)";
          return `## ${other.role ?? other.id}'s response\n\n${resp}`;
        })
        .join("\n\n");

      const debatePrompt = [
        task.prompt,
        "",
        "---",
        "## Previous Round Discussion",
        othersResponses,
        "",
        `## Round ${r} — Your Turn`,
        "Respond to the points above. If you agree, add supporting arguments.",
        "If you disagree, explain why with specifics. Refine your position.",
      ].join("\n");

      const roundTask: Task = { ...task, prompt: debatePrompt };
      return runTask(roundTask, resolved, rctx);
    });

    const roundArr = await Promise.all(roundJobs);
    roundResults.push(new Map(tasks.map((t, i) => [t.id, roundArr[i]])));
  }

  // Merge per-task results: concatenate each task's outputs across all rounds
  // and sum durationMs / token usage so the dispatch report reflects the
  // *cumulative* cost of debating, not just round 1.
  const taskResults: TaskResult[] = tasks.map((task) => {
    const allRounds: string[] = [];
    let totalDur = 0;
    let firstError: string | undefined;
    let agg: TaskResult["usage"];
    for (const rm of roundResults) {
      const tr = rm.get(task.id);
      if (!tr) continue;
      if (tr.output) allRounds.push(tr.output);
      totalDur += tr.durationMs;
      if (tr.error && !firstError) firstError = tr.error;
      if (tr.usage) {
        agg = {
          input: (agg?.input ?? 0) + tr.usage.input,
          output: (agg?.output ?? 0) + tr.usage.output,
          total: (agg?.total ?? 0) + tr.usage.total,
        };
      }
    }
    return {
      taskId: task.id,
      model: task.model,
      role: task.role,
      output: allRounds.join("\n\n---\n\n"),
      durationMs: totalDur,
      ...(firstError ? { error: firstError } : {}),
      ...(agg ? { usage: agg } : {}),
    };
  });

  // Synthesis: dedicated model summarizes the debate.
  const synthesisPrompt = buildSynthesisPrompt(tasks, roundResults, rounds);
  const synthesisModel = opts.synthesisModel ?? tasks[0].model;
  const synthesisResolved =
    resolvedModels.get("__synthesis__") ?? resolvedModels.get(tasks[0].id);
  if (!synthesisResolved) {
    return { taskResults, synthesis: "Synthesis failed: no model resolvable" };
  }

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

function buildSynthesisPrompt(
  tasks: Task[],
  roundResults: Map<string, TaskResult>[],
  totalRounds: number,
): string {
  const parts: string[] = [
    `You are synthesizing a ${totalRounds}-round debate among ${tasks.length} experts.`,
    "",
    "## Participants",
    ...tasks.map((t) => `- ${t.role ?? t.id} (${t.model})`),
    "",
    "## Debate Transcript",
  ];

  for (let r = 0; r < totalRounds; r++) {
    parts.push(`### Round ${r + 1}`);
    for (const task of tasks) {
      const tr = roundResults[r]?.get(task.id);
      if (tr?.output) {
        parts.push(`#### ${task.role ?? task.id}`);
        parts.push(tr.output);
        parts.push("");
      }
    }
  }

  parts.push(
    "---",
    "## Your Task",
    "Synthesize the debate into a final recommendation:",
    "1. Areas of consensus (all participants agree)",
    "2. Areas of disagreement (with each position summarized)",
    "3. Your final recommendation with reasoning",
    "Be specific. Reference participants by name when citing their arguments.",
  );

  return parts.join("\n");
}
