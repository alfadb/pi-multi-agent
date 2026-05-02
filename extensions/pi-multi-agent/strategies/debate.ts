/**
 * Debate strategy — N models discuss a topic over multiple rounds.
 * Round 1: all models respond independently.
 * Rounds 2..N: each model reads others' previous-round responses and responds.
 * Final: synthesis model summarizes the debate.
 */

import type {
  Task,
  TaskResult,
  DispatchOptions,
  ResolvedModel,
} from "../types.js";
import { executeRpc } from "../backends/rpc.js";
import { executePrint } from "../backends/print.js";

export async function executeDebate(
  tasks: Task[],
  resolvedModels: Map<string, ResolvedModel>,
  opts: DispatchOptions & { timeoutMs: number; extraFlags: string[] },
): Promise<{ taskResults: TaskResult[]; synthesis: string }> {
  const rounds = opts.debateRounds ?? 2;
  const mode = opts.executionMode ?? "rpc";

  // Track all responses by round
  const roundResults: Map<string, string[]>[] = [];

  // Round 1: independent responses
  const r1Jobs = tasks.map((task) => {
    const resolved = resolvedModels.get(task.id);
    if (!resolved) throw new Error(`Model not found: ${task.model}`);
    return executeSingle(task, resolved, mode, opts);
  });

  const r1Results = await Promise.all(r1Jobs);
  roundResults.push(new Map(tasks.map((t, i) => [t.id, [r1Results[i].output]])));

  // Rounds 2..N: cross-response
  for (let r = 2; r <= rounds; r++) {
    const roundJobs = tasks.map(async (task, idx) => {
      const resolved = resolvedModels.get(task.id);
      if (!resolved) throw new Error(`Model not found: ${task.model}`);

      // Build prompt with others' previous responses
      const othersResponses = tasks
        .filter((_, j) => j !== idx)
        .map((other) => {
          const responses = roundResults[r - 2].get(other.id) ?? [];
          const lastResp = responses[responses.length - 1] ?? "(no response)";
          return `## ${other.role ?? other.id}'s response\n\n${lastResp}`;
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
      return executeSingle(roundTask, resolved, mode, opts);
    });

    const roundResultsArr = await Promise.all(roundJobs);
    for (let i = 0; i < tasks.length; i++) {
      const existing = roundResults[r - 2].get(tasks[i].id) ?? [];
      existing.push(roundResultsArr[i].output);
      roundResults.push(
        new Map([[tasks[i].id, existing]]),
      );
    }
  }

  // Merge per-task results for display
  const taskResults: TaskResult[] = tasks.map((task) => {
    // Find all this task's responses across rounds
    const allRounds: string[] = [];
    for (const rm of roundResults) {
      const responses = rm.get(task.id);
      if (responses) allRounds.push(...responses);
    }
    return {
      taskId: task.id,
      model: task.model,
      role: task.role,
      output: allRounds.join("\n\n---\n\n"),
      durationMs: 0,
    };
  });

  // Synthesis
  const synthesisPrompt = buildSynthesisPrompt(tasks, roundResults, rounds);
  const synthesisModel = opts.synthesisModel ?? tasks[0].model;
  const synthesisResolved = resolvedModels.get("__synthesis__")
    ?? resolvedModels.get(tasks[0].id);
  if (!synthesisResolved) throw new Error("No model for synthesis");

  const synthesisTask: Task = {
    id: "__synthesis__",
    model: synthesisModel,
    thinking: opts.synthesisThinking ?? "high",
    prompt: synthesisPrompt,
  };

  const synthesisResult = await executeSingle(synthesisTask, synthesisResolved, mode, opts);

  return { taskResults, synthesis: synthesisResult.output };
}

function buildSynthesisPrompt(
  tasks: Task[],
  roundResults: Map<string, string[]>[],
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
      const responses = roundResults[r]?.get(task.id) ?? [];
      const lastResp = responses[responses.length - 1];
      if (lastResp) {
        parts.push(`#### ${task.role ?? task.id}`);
        parts.push(lastResp);
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

async function executeSingle(
  task: Task,
  resolved: ResolvedModel,
  mode: string,
  opts: { timeoutMs: number; extraFlags: string[] },
): Promise<TaskResult> {
  if (mode === "rpc") {
    return executeRpc(task, resolved, {
      taskTimeoutMs: opts.timeoutMs,
      extraFlags: opts.extraFlags,
    });
  }
  return executePrint(task, resolved, {
    taskTimeoutMs: opts.timeoutMs,
    extraFlags: opts.extraFlags,
  });
}
