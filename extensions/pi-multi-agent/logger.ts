/**
 * logger.ts — single-line structured dispatch log.
 *
 * Every multi_dispatch event writes one line to <cwd>/.pi-multi-agent/dispatch.log.
 * The format mirrors pi-sediment's sidecar.log (same author, same conventions)
 * so existing log-reading muscle memory works across both:
 *
 *   <ISO-8601>   <event>   key=val   key=val   ...
 *
 * Why a separate logger module instead of importing pi-sediment's:
 *   - Different log path (.pi-multi-agent/ vs .pi-sediment/) — different
 *     consumers, different rotation cadences, separate lifecycle.
 *   - pi-multi-agent is a sibling project that pi-sediment shouldn't depend
 *     on or vice versa. Both reach into the same author conventions but
 *     stay decoupled at the package level.
 *
 * Hard rules (same as sidecar.log):
 *   1. ONE line per call. Embedded newlines/CRs escaped to \n / \r so a
 *      misbehaving caller can't pollute the log with multi-line garbage.
 *   2. Cap each line at LOG_LINE_MAX_CHARS — pathological prompt/output
 *      lengths get truncated with [...truncated N chars] marker.
 *   3. Rotate to .log.1 when crossing LOG_ROTATE_BYTES (single generation;
 *      keep the most recent rotation as forensic backup, no accumulation).
 *   4. Silent on I/O failure. Logging is observability, not load-bearing.
 *
 * Why a structured key=val format rather than JSON:
 *   - greppable: `grep "task:end" dispatch.log` works.
 *   - tail-friendly: a human running `tail -f` sees full lines.
 *   - each line keyspace is small + flat; JSON's nesting and quoting tax
 *     pays no dividend here. If a downstream tool needs JSON, parse the
 *     key=val with a one-liner.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const LOG_LINE_MAX_CHARS = 1000;
const LOG_ROTATE_BYTES = 2_000_000; // 2 MB — ~20K typical lines
const LOG_DIR_NAME = ".pi-multi-agent";
const LOG_FILE_NAME = "dispatch.log";

function escapeForLog(line: string): string {
  return line.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function rotateIfNeeded(logPath: string): void {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size < LOG_ROTATE_BYTES) return;
    fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    /* rotation is best-effort */
  }
}

/** Encode a value for the key=val format. Strings with spaces/quotes are
 *  JSON-quoted so the log line stays parseable; numbers/bools/null print bare. */
function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  // If it has whitespace or `=` or `"`, JSON-quote so a tab/space inside a
  // value can't fool a column-splitting reader.
  if (/[\s="]/.test(s)) return JSON.stringify(s);
  return s;
}

/**
 * Write one structured event line. Pass an event tag plus arbitrary k/v
 * fields. Field order is the order keys() iterates the object — TS preserves
 * insertion order, so callers control the column layout.
 *
 * Example:
 *   logEvent(cwd, "task:start", { id: "rev", model: "openai/gpt-5.5", thinking: "high" })
 * → 2026-05-05T03:19:27.768Z task:start id=rev model=openai/gpt-5.5 thinking=high
 */
export function logEvent(
  cwd: string,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (!cwd) return; // no log target; observability disabled
  try {
    const dir = path.join(cwd, LOG_DIR_NAME);
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, LOG_FILE_NAME);
    rotateIfNeeded(logPath);

    const parts = [event];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(`${k}=${fmtVal(v)}`);
    }
    let safe = escapeForLog(parts.join(" "));
    if (safe.length > LOG_LINE_MAX_CHARS) {
      const elided = safe.length - LOG_LINE_MAX_CHARS + 50;
      safe = safe.slice(0, LOG_LINE_MAX_CHARS - 50) +
        `[...${elided} chars truncated...]`;
    }
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${safe}\n`);
  } catch {
    /* silent: logging must never crash the dispatch */
  }
}

/**
 * Clamp a long string to N chars, appending an ellipsis when truncated.
 * Used by callers to keep prompt/arg summaries inline without bloating
 * the line past LOG_LINE_MAX_CHARS.
 */
export function clip(s: string | undefined, n: number = 80): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}
