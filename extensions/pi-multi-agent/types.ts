/**
 * pi-multi-agent types — shared across strategies and backends.
 */

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
  /** Optional tools allowlist (comma-separated). Omit for full tool access. */
  tools?: string;
}

/** Strategy determines how tasks are executed and combined. */
export type Strategy = "parallel" | "debate" | "chain" | "ensemble";

/** Backend determines the execution mechanism. */
export type ExecutionMode = "print" | "rpc" | "tmux" | "sdk";

/** Options controlling the overall dispatch. */
export interface DispatchOptions {
  /** Number of debate rounds (debate strategy only). Default 2. */
  debateRounds?: number;
  /** Model to use for final synthesis (debate/ensemble). Default: first task's model. */
  synthesisModel?: string;
  /** Synthesis thinking level. Default: "high". */
  synthesisThinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Override the auto-selected execution mode. */
  executionMode?: ExecutionMode;
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
  executionMode: ExecutionMode;
  tasks: TaskResult[];
  /** Synthesis output (debate/ensemble strategies). */
  synthesis?: string;
  /** Total wall-clock duration in ms. */
  totalDurationMs: number;
  /** Any dispatch-level errors. */
  error?: string;
}

/** Resolved model info from the registry. */
export interface ResolvedModel {
  provider: string;
  modelId: string;
  apiKey: string;
  headers: Record<string, string>;
  baseUrl?: string;
}
