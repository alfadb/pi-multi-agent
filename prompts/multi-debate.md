# Multi-Debate — 多模型辩论讨论

调用 `multi_dispatch` 以 debate 策略让多个模型围绕一个话题进行多轮辩论。

## 前提

- 已确定讨论话题和参与角色
- 可选：指定辩论轮数（默认 2）

## 执行

```
multi_dispatch(
  strategy="debate",
  tasks=[
    {id:"role1", model:"openai/gpt-5.5-pro", thinking:"xhigh",
     role:"角色1", prompt:"{TOPIC}"},
    {id:"role2", model:"anthropic/claude-sonnet-4", thinking:"xhigh",
     role:"角色2", prompt:"{TOPIC}"},
    {id:"role3", model:"deepseek/deepseek-v4-pro", thinking:"xhigh",
     role:"角色3", prompt:"{TOPIC}"},
  ],
  options={
    debateRounds: {ROUNDS},
    synthesisModel: "{SYNTHESIS_MODEL}",
    synthesisThinking: "xhigh"
  }
)
```

## 变量

- `{TOPIC}`：讨论话题
- `{ROUNDS}`：辩论轮数（默认 2，建议 2-3）
- `{SYNTHESIS_MODEL}`：综合模型（如 `"openai/gpt-5.5"`）

## 结果

返回结构包含：
- 每个参与者每轮的观点
- 综合阶段的共识点、分歧点、最终建议
