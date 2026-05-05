# Multi-RedTeam — 对抗性安全审查

调用 `multi_dispatch` 以 debate 策略进行攻击者 vs 防守者的多轮对抗审查。

## 模型选择

先执行 `pi --list-models` 确认可用模型。**攻击者和防守者必须选择不同 provider 系列的最强模型**：

- 攻击者（red-team）：需要最强推理，找漏洞、构造攻击。优先 openai/gpt-5.5，其次 anthropic 最强
- 防守者（blue-team）：需要最强推理，澄清误报、评估影响。优先 anthropic 最强，其次 openai/gpt-5.5

thinking 统一 `xhigh`。综合模型用第三个 provider 或攻击者模型。

## 执行

```
multi_dispatch(
  strategy="debate",
  tasks=[
    {id:"attacker", model:"<攻击者模型>", thinking:"xhigh",
     role:"攻击者", prompt:"你的任务是找出以下代码中的所有安全漏洞。假设作者犯了错误，构造攻击场景。不要手软。

—— 代码 diff ——
{DIFF}

—— 已知的审查发现（如有）——
{PRIOR_FINDINGS}"},

    {id:"defender", model:"<防守者模型>", thinking:"xhigh",
     role:"防守者", prompt:"你的任务是审查攻击者提出的每一个漏洞。区分真正的漏洞和误报（false positive）。对真正的漏洞评估影响程度。对攻击者过度解读的部分给出澄清。

—— 代码 diff ——
{DIFF}"},
  ],
  options={
    debateRounds: {ROUNDS},
    synthesisModel: "<综合模型>",
    synthesisThinking: "xhigh"
  }
)
```

## 变量

- `{DIFF}`：待审查的代码 diff
- `{PRIOR_FINDINGS}`：之前审查已发现的问题（可选，帮助攻击者深入）
- `{ROUNDS}`：对抗轮数（默认 2，建议 2-3）

## 结果处理

1. 综合阶段会得出：
   - 确认的漏洞（攻击者和防守者达成一致）
   - 误报（防守者成功反驳）
   - 争议（双方各执一词，需要人工判断）
2. 将确认的漏洞合并到主审查输出
3. 争议项标注 `[REDTEAM-DISPUTED]`
