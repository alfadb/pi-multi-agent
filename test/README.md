# Tests

## integration.test.mjs

End-to-end test against real LLM providers (gpt-5.5 / opus-4-7 / deepseek-v4-pro).

Run from the repo root:

```bash
bun test/integration.test.mjs
```

Set `MULTI_AGENT_TEST_FAST=1` to skip multi-model + heavy tests (still
covers all code paths via mocks where possible):

```bash
MULTI_AGENT_TEST_FAST=1 bun test/integration.test.mjs
```

### Coverage

- Tool whitelist (`validateTools`, `buildSubagentTools`, `rejectionMessage`)
  - Including mutating-tool gating by `PI_MULTI_AGENT_ALLOW_MUTATING=1`
- `runTask`: pure reasoning, with tools, abort (live + pre-aborted), reject
- Path traversal defense (`vision-core` rejects `/etc/passwd`, `..` escape, non-image ext)
- `MAX_TOOL_TURNS` and `MAX_TASKS_PER_DISPATCH` invariants (code-level)
- Strategies: `parallel`, `ensemble` (incl. all-error skip), `chain` (fail-fast),
  `debate` (durationMs accumulation)
- Process audit: no subprocess pi spawned during the run

### Requirements

The test reads `~/.pi/agent/auth.json` and `~/.pi/agent/models.json` to find
real API keys. It will fail with a setup error if these aren't configured.

Models needed (any subset triggers FATAL): `openai/gpt-5.5`, `openai/gpt-5`,
`anthropic/claude-opus-4-7`, `anthropic/claude-sonnet-4-6`,
`deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-flash`.

### Cost

A full run takes ~30-60s wall time and burns 5-10k tokens across all
providers. `MULTI_AGENT_TEST_FAST=1` cuts to ~10s and ~1k tokens.

### CI integration

Recommended GitHub Actions invocation (when API keys are available as repo
secrets):

```yaml
- name: Integration tests
  env:
    OPENAI_API_KEY:    ${{ secrets.OPENAI_API_KEY }}
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    DEEPSEEK_API_KEY:  ${{ secrets.DEEPSEEK_API_KEY }}
  run: bun test/integration.test.mjs
```
