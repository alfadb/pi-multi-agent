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
  /**
   * Vision tool: ordered preference list, most-preferred first.
   * Each entry is "provider/idSubstring" — substring match on model id (case-insensitive),
   * tolerant of version suffixes (e.g. "openai/gpt-5.5-pro" matches "gpt-5.5-pro-2026-07-15").
   * Models matching earlier entries win. Unmatched models still participate, ordered by
   * cost.input descending as a rough capability proxy.
   * The current main model is always excluded (if it supported images, vision wouldn't be called).
   */
  visionModelPreferences: string[];
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
  visionModelPreferences: [
    "openai/gpt-5.5-pro",
    "openai/gpt-5.5",
    "anthropic/claude-opus-4-7",
    "openai/gpt-5",
    "anthropic/claude-opus",
    "openai/gpt-4.1",
    "anthropic/claude-sonnet",
    "google/gemini",
  ],
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
    visionModelPreferences:
      (projectConfig.visionModelPreferences as string[]) ??
      DEFAULT_CONFIG.visionModelPreferences,
  };
}
