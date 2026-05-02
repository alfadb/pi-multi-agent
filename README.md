# pi-multi-agent

Multi-model parallel agent dispatch for [pi coding agent](https://github.com/badlogic/pi-mono).

Register a single tool — `multi_dispatch` — that lets the LLM spawn parallel, debate, chain, or ensemble sub-agent tasks across different models, thinking levels, and execution backends.

## Strategies

| Strategy | Description | Default Backend |
|---|---|---|
| `parallel` | All tasks run concurrently, independent | `print` |
| `debate` | Multi-round cross-model discussion + synthesis | `rpc` |
| `chain` | Sequential A→B→C, each building on previous | `rpc` |
| `ensemble` | Independent votes on same prompt + synthesis | `print` |

## Backends

| Backend | Mechanism | Best for |
|---|---|---|
| `print` | `pi --print` subprocess | Stateless single-turn analysis |
| `rpc` | `pi --mode rpc` subprocess | Multi-turn debate/chain |
| `sdk` | (planned) In-process AgentSession | Tight orchestration |

## Install

```bash
pi install git:github.com/alfadb/pi-multi-agent
```

Or as submodule:

```bash
git submodule add https://github.com/alfadb/pi-multi-agent agent/skills/pi-multi-agent
```

Add to `settings.json`:

```json
{
  "extensions": [
    "~/.pi/agent/skills/pi-multi-agent/extensions/pi-multi-agent"
  ]
}
```

## Usage

The LLM calls `multi_dispatch` from any skill or prompt:

```
# Parallel code review
multi_dispatch(
  strategy="parallel",
  tasks=[
    {id:"sec", model:"anthropic/claude-sonnet-4", thinking:"xhigh",
     prompt:"Review this diff for security issues: {DIFF}"},
    {id:"perf", model:"deepseek/deepseek-v4-pro", thinking:"xhigh",
     prompt:"Review this diff for performance issues: {DIFF}"},
    {id:"arch", model:"openai/gpt-5.5", thinking:"xhigh",
     prompt:"Review this diff for architecture issues: {DIFF}"},
  ]
)

# Design debate
multi_dispatch(
  strategy="debate",
  tasks=[
    {id:"ceo", model:"openai/gpt-5.5-pro", thinking:"xhigh",
     role:"CEO", prompt="Evaluate this product proposal: {PROPOSAL}"},
    {id:"cto", model:"anthropic/claude-sonnet-4", thinking:"xhigh",
     role:"CTO", prompt="Evaluate this product proposal: {PROPOSAL}"},
    {id:"cfo", model:"deepseek/deepseek-v4-pro", thinking:"xhigh",
     role:"CFO", prompt="Evaluate this product proposal: {PROPOSAL}"},
  ],
  options={debateRounds:3, synthesisModel:"openai/gpt-5.5"}
)

# Chain coding
multi_dispatch(
  strategy="chain",
  tasks=[
    {id:"impl", model:"openai/gpt-5.5", thinking:"xhigh",
     prompt="Implement JWT auth middleware in src/auth.ts"},
    {id:"review", model:"anthropic/claude-sonnet-4", thinking:"xhigh",
     prompt="Review the auth implementation above for security flaws"},
    {id:"fix", model:"openai/gpt-5.5", thinking:"xhigh",
     prompt="Apply the security fixes suggested by the review"},
  ]
)
```

## Configuration

Optional project config at `.pi-multi-agent/config.json`:

```json
{
  "strategyModes": {
    "parallel": "print",
    "debate": "rpc"
  },
  "taskTimeoutMs": 600000,
  "debateRounds": 3,
  "synthesisThinking": "xhigh"
}
```

## License

MIT
