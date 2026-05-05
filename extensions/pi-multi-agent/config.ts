/**
 * pi-multi-agent config — defaults + project-local overrides.
 *
 * SDK-only architecture: there is no "execution mode" knob anymore — every
 * dispatch runs in-process via completeSimple. The previous strategyModes /
 * extraPiFlags fields have been removed; loading legacy config files just
 * ignores those keys (no-op), so older .pi-multi-agent/config.json files
 * remain valid for the fields we still honor below.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface MultiAgentConfig {
  /** Default task timeout in ms. */
  taskTimeoutMs: number;
  /** Default debate rounds. */
  debateRounds: number;
  /** Default synthesis thinking level. */
  synthesisThinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /**
   * Vision tool: ordered preference list, most-preferred first.
   * Each entry is "provider/idSubstring" — substring match on model id (case-insensitive),
   * tolerant of version suffixes (e.g. "openai/gpt-5.5" matches "gpt-5.5-2026-07-15").
   * Models matching earlier entries win. Unmatched models still participate, ordered by
   * cost.input descending as a rough capability proxy.
   * The current main model is excluded by the vision tool itself.
   *
   * Default is now an EMPTY list — model selection authority lives in pi-model-curator,
   * which advertises capability hints (including image-input flag) into the main session
   * system prompt. Vision-core falls back to cost.input descending across all
   * image-capable models, which is a reasonable proxy for "strongest available". A
   * project that wants a hard preference can still set this in .pi-multi-agent/config.json.
   */
  visionModelPreferences: string[];
}

export const DEFAULT_CONFIG: MultiAgentConfig = {
  taskTimeoutMs: 300_000,
  debateRounds: 2,
  synthesisThinking: "high",
  visionModelPreferences: [],
};

function readJsonSafe(p: string): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}

export function loadConfig(projectRoot: string): MultiAgentConfig {
  const projectConfig = readJsonSafe(
    path.join(projectRoot, ".pi-multi-agent", "config.json"),
  );

  return {
    taskTimeoutMs:
      (projectConfig.taskTimeoutMs as number) ?? DEFAULT_CONFIG.taskTimeoutMs,
    debateRounds:
      (projectConfig.debateRounds as number) ?? DEFAULT_CONFIG.debateRounds,
    synthesisThinking:
      (projectConfig.synthesisThinking as typeof DEFAULT_CONFIG.synthesisThinking) ??
      DEFAULT_CONFIG.synthesisThinking,
    visionModelPreferences:
      (projectConfig.visionModelPreferences as string[]) ??
      DEFAULT_CONFIG.visionModelPreferences,
  };
}
