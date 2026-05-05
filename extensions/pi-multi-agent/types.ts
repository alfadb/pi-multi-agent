/**
 * pi-multi-agent types — shared across strategies and the SDK runner.
 *
 * SDK-only architecture: every task = one in-process LLM call (with optional
 * tool-calling loop). No subprocess, no execution-mode switching.
 */

import type { Model } from "@mariozechner/pi-ai";

/** A single task dispatched to one model. */
export interface Task {
  /** Unique identifier within this dispatch (used for result correlation). */
  id: string;
  /** Provider/model string, e.g. "openai/gpt-5.5" or "anthropic/claude-sonnet-4". */
  model: string;
  /** Thinking level for this task. */
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** The prompt sent to the model. */
  prompt: string;
  /** Optional role label (shown in status/logs). */
  role?: string;
  /**
   * Optional comma-separated tool allowlist.
   *
   * Accepted entries:
   *   - SDK built-ins: read, bash, edit, write, grep, find, ls
   *     (mutating: bash/edit/write require env PI_MULTI_AGENT_ALLOW_MUTATING=1)
   *   - Alias: "readonly" (=read,grep,find,ls). The historical "coding" alias
   *     was removed in 32c262b because the name implied safety and it bundled
   *     write tools; list mutating tools explicitly to opt in.
   *   - Multi-agent self-delegatable tools: vision, imagine
   *
   * Anything else (including multi_dispatch and third-party extension tools)
   * is rejected with an error in the task's result. Subagents cannot trigger
   * nested dispatches or carry the host's ExtensionContext.
   *
   * Omit for a pure-reasoning task (no tools).
   */
  tools?: string;
}

/** Strategy determines how tasks are executed and combined. */
export type Strategy = "parallel" | "debate" | "chain" | "ensemble";

/** Options controlling the overall dispatch. */
export interface DispatchOptions {
  /** Number of debate rounds (debate strategy only). Default 2. */
  debateRounds?: number;
  /** Model to use for final synthesis (debate/ensemble). Default: first task's model. */
  synthesisModel?: string;
  /** Synthesis thinking level. Default: "high". */
  synthesisThinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Timeout per task in milliseconds. Default 300_000. */
  taskTimeoutMs?: number;
}

/** Result from a single task. */
export interface TaskResult {
  taskId: string;
  model: string;
  role?: string;
  output: string;
  error?: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Token usage if available. */
  usage?: {
    input: number;
    output: number;
    reasoning?: number;
    total: number;
  };
}

/** Full dispatch result returned to the LLM. */
export interface DispatchResult {
  strategy: Strategy;
  tasks: TaskResult[];
  /** Synthesis output (debate/ensemble strategies). */
  synthesis?: string;
  /** Total wall-clock duration in ms. */
  totalDurationMs: number;
  /** Any dispatch-level errors. */
  error?: string;
}

/** Resolved model info from the registry, ready for completeSimple. */
export interface ResolvedModel {
  provider: string;
  modelId: string;
  /** Concrete Model<Api> object for completeSimple. */
  model: Model<any>;
  apiKey: string;
  headers: Record<string, string>;
  baseUrl?: string;
}
