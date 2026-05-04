/**
 * Integration tests for the SDK-only multi-agent runtime.
 *
 * Hits real LLM providers (gpt-5.5, opus-4-7, deepseek-v4-pro, etc.). Uses
 * `bun:test`-style describe/it via a minimal harness — running this file
 * directly with `bun test/integration.test.mjs` is enough; no test framework
 * dependency. Set MULTI_AGENT_TEST_FAST=1 to skip multi-model + heavy tests.
 *
 * Coverage:
 *   - Tool whitelist (validateTools, buildSubagentTools, rejectionMessage)
 *   - runTask: pure reasoning, with tools, abort (live + pre-aborted), reject
 *   - Path traversal defense (vision-core)
 *   - Mutating tools gated by env (subagent-tools)
 *   - MAX_TOOL_TURNS cap (runner)
 *   - MAX_TASKS_PER_DISPATCH cap (index, schema-level)
 *   - Strategies: parallel, ensemble, chain (fail-fast), debate (durations)
 *   - Process audit: no subprocess pi spawned during the run
 */

import {
  ModelRegistry,
  AuthStorage,
  getAgentDir,
} from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const MA = path.resolve(HERE, "..", "extensions", "pi-multi-agent");

const { runTask, missingModelResult } = await import(`${MA}/runner.ts`);
const { validateTools, rejectionMessage, buildSubagentTools, mutatingToolsAllowed } =
  await import(`${MA}/subagent-tools.ts`);
const { executeParallel } = await import(`${MA}/strategies/parallel.ts`);
const { executeEnsemble }  = await import(`${MA}/strategies/ensemble.ts`);
const { executeChain }     = await import(`${MA}/strategies/chain.ts`);
const { executeDebate }    = await import(`${MA}/strategies/debate.ts`);
const { analyzeImage }     = await import(`${MA}/tools/vision-core.ts`);

const FAST = process.env.MULTI_AGENT_TEST_FAST === "1";

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

async function it(name, fn, { skip = false } = {}) {
  if (skip) {
    skipped++;
    console.log(`[SKIP] ${name}`);
    return;
  }
  try {
    const detail = await fn();
    passed++;
    console.log(`[PASS] ${name}${detail ? " — " + detail : ""}`);
  } catch (e) {
    failed++;
    const msg = e?.message ?? String(e);
    failures.push({ name, msg });
    console.log(`[FAIL] ${name} — ${msg}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "assertion failed");
}

// ── Setup: real model registry ──────────────────────────────────
const auth = await AuthStorage.create(getAgentDir() + "/auth.json");
const registry = ModelRegistry.create(auth, getAgentDir() + "/models.json");
await registry.refresh();
const all = await registry.getAvailable();

async function resolve(provModel) {
  const [prov, id] = provModel.split("/");
  const m = all.find((x) => x.provider === prov && x.id === id);
  if (!m) throw new Error("not in registry: " + provModel);
  const a = await registry.getApiKeyAndHeaders(m);
  if (!a.ok) throw new Error("auth: " + provModel);
  return { provider: prov, modelId: id, model: m, apiKey: a.apiKey, headers: a.headers ?? {} };
}

const M = {};
try {
  M.gpt55     = await resolve("openai/gpt-5.5");
  M.gpt5      = await resolve("openai/gpt-5");
  M.opus47    = await resolve("anthropic/claude-opus-4-7");
  M.sonnet46  = await resolve("anthropic/claude-sonnet-4-6");
  M.deepPro   = await resolve("deepseek/deepseek-v4-pro");
  M.deepFlash = await resolve("deepseek/deepseek-v4-flash");
} catch (e) {
  console.error("FATAL: couldn't resolve required models:", e.message);
  process.exit(99);
}

const baseRctx = {
  cwd: path.resolve(HERE, ".."),
  modelRegistry: registry,
  visionPrefs: [],
  taskTimeoutMs: 60_000,
};

console.log(`\nRunning integration tests (FAST=${FAST ? "yes" : "no"})\n`);

// ── 1. Tool whitelist ──────────────────────────────────────────
await it("validateTools/undefined+empty", async () => {
  const a = validateTools(undefined);
  const b = validateTools("");
  assert(a.names.length === 0 && a.rejected.length === 0);
  assert(b.names.length === 0 && b.rejected.length === 0);
});

await it("validateTools/readonly-alias-expands", async () => {
  const r = validateTools("readonly");
  assert(JSON.stringify(r.names) === JSON.stringify(["read", "grep", "find", "ls"]));
  assert(r.rejected.length === 0);
});

await it("validateTools/multi_dispatch-rejected", async () => {
  const r = validateTools("multi_dispatch");
  assert(r.rejected.includes("multi_dispatch"));
});

await it("validateTools/foreign-extension-rejected", async () => {
  const r = validateTools("browse,fancy_tool");
  assert(r.rejected.length === 2);
});

await it("validateTools/mutating-gated-by-env", async () => {
  // Save original env
  const orig = process.env.PI_MULTI_AGENT_ALLOW_MUTATING;
  delete process.env.PI_MULTI_AGENT_ALLOW_MUTATING;
  assert(!mutatingToolsAllowed(), "should be disabled by default");
  let r = validateTools("bash,edit,write");
  assert(r.rejected.length === 3, `expected 3 rejected, got ${r.rejected.length}`);
  process.env.PI_MULTI_AGENT_ALLOW_MUTATING = "1";
  assert(mutatingToolsAllowed());
  r = validateTools("bash,edit,write");
  assert(r.rejected.length === 0, `expected 0 rejected when env set, got ${r.rejected.length}`);
  // Restore
  if (orig === undefined) delete process.env.PI_MULTI_AGENT_ALLOW_MUTATING;
  else process.env.PI_MULTI_AGENT_ALLOW_MUTATING = orig;
});

await it("rejectionMessage/explains-mutating", async () => {
  delete process.env.PI_MULTI_AGENT_ALLOW_MUTATING;
  const m = rejectionMessage(["bash"]);
  assert(m.includes("mutating tool"), "should explain mutating");
  assert(m.includes("PI_MULTI_AGENT_ALLOW_MUTATING"), "should mention env var");
});

await it("rejectionMessage/explains-multi_dispatch", async () => {
  const m = rejectionMessage(["multi_dispatch"]);
  assert(m.includes("nested dispatch"));
});

await it("buildSubagentTools/readonly-yields-4-tools", async () => {
  const r = await buildSubagentTools("readonly", {
    cwd: baseRctx.cwd,
    modelRegistry: registry,
    taskModel: M.gpt55.model,
    visionPrefs: [],
  });
  assert(r.tools.length === 4);
  const names = r.tools.map((t) => t.name).sort();
  assert(JSON.stringify(names) === JSON.stringify(["find", "grep", "ls", "read"]));
});

await it("buildSubagentTools/vision+imagine-shape", async () => {
  const r = await buildSubagentTools("vision,imagine", {
    cwd: baseRctx.cwd,
    modelRegistry: registry,
    taskModel: M.gpt55.model,
    visionPrefs: [],
  });
  assert(r.tools.length === 2);
  for (const t of r.tools) assert(typeof t.execute === "function");
});

// ── 2. Path traversal defense (no LLM) ─────────────────────────
await it("vision/path-traversal-rejected (absolute outside cwd)", async () => {
  const r = await analyzeImage(
    { path: "/etc/passwd", prompt: "x" },
    { modelRegistry: registry, prefs: [], cwd: baseRctx.cwd },
  );
  assert(r.ok === false);
  // Either ext rejected (no .png ext on /etc/passwd) or path rejected.
  assert(/extension|outside the project root/.test(r.error), r.error);
});

await it("vision/path-traversal-rejected (../ escape)", async () => {
  const r = await analyzeImage(
    { path: "../../../etc/passwd.png", prompt: "x" },
    { modelRegistry: registry, prefs: [], cwd: baseRctx.cwd },
  );
  assert(r.ok === false);
  assert(/outside the project root/.test(r.error), r.error);
});

await it("vision/path-non-image-extension-rejected", async () => {
  const r = await analyzeImage(
    { path: "auth.json", prompt: "x" },
    { modelRegistry: registry, prefs: [], cwd: baseRctx.cwd },
  );
  assert(r.ok === false);
  assert(/extension/.test(r.error), r.error);
});

// ── 3. runTask basics ──────────────────────────────────────────
await it("runTask/pure-reasoning gpt-5", async () => {
  const r = await runTask(
    { id: "t", model: "openai/gpt-5", thinking: "off", prompt: "Reply with EXACTLY 'PING'." },
    M.gpt5, baseRctx,
  );
  assert(!r.error, r.error);
  assert(/ping/i.test(r.output), r.output);
  assert(r.usage?.input > 0 && r.usage?.output > 0);
  return `${r.durationMs}ms in=${r.usage.input} out=${r.usage.output}`;
});

await it("runTask/abort-fast-live", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 500);
  const start = Date.now();
  const r = await runTask(
    { id: "ab", model: "openai/gpt-5", thinking: "high", prompt: "Write 5000 words." },
    M.gpt5, { ...baseRctx, signal: ac.signal },
  );
  const w = Date.now() - start;
  assert(w < 2500, `took ${w}ms`);
  assert(r.error && /abort/i.test(r.error));
  return `${w}ms`;
});

await it("runTask/abort-fast-pre-aborted (F2 regression)", async () => {
  const ac = new AbortController(); ac.abort();
  const start = Date.now();
  const r = await runTask(
    { id: "ab2", model: "openai/gpt-5", thinking: "high", prompt: "Write 5000 words." },
    M.gpt5, { ...baseRctx, signal: ac.signal },
  );
  const w = Date.now() - start;
  assert(w < 200, `took ${w}ms — should be <200`);
  return `${w}ms (CRITICAL F2)`;
});

await it("runTask/rejected-tool-fast (no LLM call)", async () => {
  const start = Date.now();
  const r = await runTask(
    { id: "rj", model: "openai/gpt-5", thinking: "off", prompt: "anything",
      tools: "multi_dispatch,browse" },
    M.gpt5, baseRctx,
  );
  const w = Date.now() - start;
  assert(w < 100, `took ${w}ms — should be 0`);
  assert(r.error?.includes("rejected"));
  return `${w}ms`;
});

await it("runTask/with-readonly-tool gpt-5.5", async () => {
  const r = await runTask(
    { id: "tool", model: "openai/gpt-5.5", thinking: "off", tools: "readonly",
      prompt: "Use the ls tool on '" + baseRctx.cwd + "'. Reply 'count=N' where N is number of .md files." },
    M.gpt55, baseRctx,
  );
  assert(!r.error, r.error);
  assert(/count\s*=\s*\d+/i.test(r.output), r.output);
  return `${r.durationMs}ms`;
});

// ── 4. Strategies ─────────────────────────────────────────────
await it("parallel/4-providers-concurrent", async () => {
  const tasks = [
    { id: "a", model: "openai/gpt-5.5",            thinking: "off", prompt: "Say A." },
    { id: "b", model: "anthropic/claude-opus-4-7", thinking: "off", prompt: "Say B." },
    { id: "c", model: "deepseek/deepseek-v4-pro",  thinking: "off", prompt: "Say C." },
    { id: "d", model: "anthropic/claude-sonnet-4-6", thinking: "off", prompt: "Say D." },
  ];
  const map = new Map([
    ["a", M.gpt55], ["b", M.opus47], ["c", M.deepPro], ["d", M.sonnet46],
  ]);
  const start = Date.now();
  const r = await executeParallel(tasks, map, baseRctx, {});
  const wall = Date.now() - start;
  for (const tr of r) {
    assert(!tr.error, `${tr.taskId}: ${tr.error}`);
    assert(tr.output.trim().length > 0, `${tr.taskId} empty`);
  }
  const sum = r.reduce((s, x) => s + x.durationMs, 0);
  assert(wall < sum * 0.8, `not concurrent: wall=${wall} sum=${sum}`);
  return `wall=${wall}ms sum=${sum}ms (concurrent confirmed)`;
}, { skip: FAST });

await it("ensemble/3-models+opus-synth", async () => {
  const tasks = [
    { id: "a", model: "openai/gpt-5.5",            thinking: "off", prompt: "Is 2+2=4? yes/no." },
    { id: "b", model: "anthropic/claude-sonnet-4-6", thinking: "off", prompt: "Is 2+2=4? yes/no." },
    { id: "c", model: "deepseek/deepseek-v4-pro",   thinking: "off", prompt: "Is 2+2=4? yes/no." },
  ];
  const map = new Map([
    ["a", M.gpt55], ["b", M.sonnet46], ["c", M.deepPro],
    ["__synthesis__", M.opus47],
  ]);
  const r = await executeEnsemble(tasks, map, baseRctx, {
    synthesisModel: "anthropic/claude-opus-4-7",
    synthesisThinking: "off",
  });
  for (const tr of r.taskResults) {
    assert(!tr.error, `${tr.taskId}: ${tr.error}`);
    assert(tr.output.trim());
  }
  assert(r.synthesis.length > 20);
  assert(/yes/i.test(r.synthesis));
  return `synth=${r.synthesis.length}c`;
}, { skip: FAST });

await it("ensemble/synth-skip-on-all-error (F25 regression)", async () => {
  const tasks = [
    { id: "a", model: "fake/x",  thinking: "off", prompt: "x" },
    { id: "b", model: "fake/y",  thinking: "off", prompt: "x" },
  ];
  const map = new Map();
  const r = await executeEnsemble(tasks, map, baseRctx, {
    synthesisModel: "openai/gpt-5", synthesisThinking: "off",
  });
  assert(r.synthesis.includes("Synthesis skipped"),
    "expected 'Synthesis skipped' got: " + r.synthesis.slice(0, 100));
});

await it("chain/fail-fast (A8 regression)", async () => {
  const tasks = [
    { id: "ok",   model: "openai/gpt-5", thinking: "off", prompt: "Say HELLO." },
    { id: "die",  model: "fake/nope",   thinking: "off", prompt: "x" },
    { id: "skip", model: "openai/gpt-5", thinking: "off", prompt: "Translate to French." },
  ];
  const map = new Map([["ok", M.gpt5], ["skip", M.gpt5]]);
  const r = await executeChain(tasks, map, baseRctx, {});
  assert(r.length === 3);
  assert(!r[0].error, "step 1 should succeed");
  assert(r[1].error, "step 2 should fail (no resolved model)");
  assert(r[2].error?.includes("chain stopped"),
    "step 3 should be skipped with chain-stopped reason; got: " + r[2].error);
}, { skip: FAST });

await it("debate/durationMs accumulated (F22 regression)", async () => {
  const tasks = [
    { id: "x", model: "openai/gpt-5", thinking: "off", role: "a", prompt: "One word." },
    { id: "y", model: "deepseek/deepseek-v4-flash", thinking: "off", role: "b", prompt: "One word." },
  ];
  const map = new Map([
    ["x", M.gpt5], ["y", M.deepFlash], ["__synthesis__", M.gpt5],
  ]);
  const r = await executeDebate(tasks, map, baseRctx, {
    debateRounds: 2, synthesisModel: "openai/gpt-5", synthesisThinking: "off",
  });
  for (const tr of r.taskResults) {
    assert(tr.durationMs > 0, `${tr.taskId} durationMs=0 — F22 regression`);
  }
}, { skip: FAST });

// ── 5. MAX_TOOL_TURNS cap (A4 regression) ────────────────────
// Hard to provoke without a misbehaving model; covered by code-level invariant.
// We at least check the cap exists and is reachable in code.
await it("runner/MAX_TOOL_TURNS-constant-exists", async () => {
  const src = fs.readFileSync(`${MA}/runner.ts`, "utf8");
  assert(/MAX_TOOL_TURNS\s*=\s*\d+/.test(src), "MAX_TOOL_TURNS constant missing");
  assert(/turn\s*>\s*MAX_TOOL_TURNS/.test(src), "turn cap check missing");
});

await it("index/MAX_TASKS_PER_DISPATCH-constant-exists (A5)", async () => {
  const src = fs.readFileSync(`${MA}/index.ts`, "utf8");
  assert(/MAX_TASKS_PER_DISPATCH\s*=\s*\d+/.test(src), "MAX_TASKS_PER_DISPATCH constant missing");
  assert(/maxItems:\s*MAX_TASKS_PER_DISPATCH/.test(src), "schema cap missing");
});

// ── 6. Process audit: no subprocess pi spawned ────────────────
await it("process-audit/no-subprocess-pi-spawned", async () => {
  const out = execSync("pgrep -u worker -x pi", { encoding: "utf8" }).trim();
  const pids = out.split("\n").filter(Boolean).map(Number);
  const now = Date.now();
  const suspects = [];
  for (const pid of pids) {
    try {
      const stat = execSync(`stat -c %Y /proc/${pid}`, { encoding: "utf8" }).trim();
      const ageMs = now - Number(stat) * 1000;
      if (ageMs < 180_000) suspects.push({ pid, ageMs });
    } catch { /* gone */ }
  }
  assert(suspects.length === 0,
    "subprocess pi spawned during test: " + JSON.stringify(suspects));
  return `${pids.length} pi processes, all >180s old`;
});

// ── Summary ───────────────────────────────────────────────────
console.log(`\n${"=".repeat(60)}`);
console.log(`RESULTS: ${passed}/${passed+failed+skipped} PASS, ${failed} FAIL, ${skipped} SKIP`);
console.log("=".repeat(60));
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.msg}`);
}
process.exit(failed);
