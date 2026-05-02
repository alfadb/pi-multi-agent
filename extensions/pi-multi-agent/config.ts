/**
 * pi-multi-agent config — default strategy→mode mapping and timeouts.
 * Can be overridden via .pi-multi-agent/config.json in the project.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExecutionMode, Strategy } from "./types.js";

export interface MultiAgentConfig {
  /** Default execution mode per strategy. */
  strategyModes: Record<Strategy, ExecutionMode>;
  /** Default task timeout in ms. */
  taskTimeoutMs: number;
  /** Default debate rounds. */
  debateRounds: number;
  /** Default synthesis thinking level. */
  synthesisThinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Extra CLI flags passed to pi subprocesses. */
  extraPiFlags: string[];
}

export const DEFAULT_CONFIG: MultiAgentConfig = {
  strategyModes: {
    parallel: "print",
    debate: "rpc",
    chain: "rpc",
    ensemble: "print",
  },
  taskTimeoutMs: 300_000,
  debateRounds: 2,
  synthesisThinking: "high",
  extraPiFlags: [],
};

function readJsonSafe(p: string): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}

export function loadConfig(projectRoot: string): MultiAgentConfig {
  const projectConfig = readJsonSafe(
    path.join(projectRoot, ".pi-multi-agent", "config.json"),
  );

  return {
    strategyModes: {
      ...DEFAULT_CONFIG.strategyModes,
      ...((projectConfig.strategyModes as Record<string, ExecutionMode>) ?? {}),
    },
    taskTimeoutMs:
      (projectConfig.taskTimeoutMs as number) ?? DEFAULT_CONFIG.taskTimeoutMs,
    debateRounds:
      (projectConfig.debateRounds as number) ?? DEFAULT_CONFIG.debateRounds,
    synthesisThinking:
      (projectConfig.synthesisThinking as typeof DEFAULT_CONFIG.synthesisThinking) ??
      DEFAULT_CONFIG.synthesisThinking,
    extraPiFlags:
      (projectConfig.extraPiFlags as string[]) ?? DEFAULT_CONFIG.extraPiFlags,
  };
}
