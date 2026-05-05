# Multi-Debate — 多模型辩论讨论

调用 `multi_dispatch` 以 debate 策略让多个模型围绕一个话题进行多轮辩论。

## 模型选择

参考系统提示中的 **Available models (curated)** 表格。**每个角色选择不同 provider 系列的模型**以最大化视角多样性；按 hint 列匹配角色需求（推理深度 / 成本 / 速度）。如可用 provider 不足 3 个，从同一 provider 选 hint 差异最大的两条。thinking 统一 `xhigh`，除非任务对延迟特别敏感。

## 执行

```
multi_dispatch(
  strategy="debate",
  tasks=[
    {id:"role1", model:"<按原则选择>", thinking:"xhigh",
     role:"角色1", prompt:"{TOPIC}"},
    {id:"role2", model:"<按原则选择>", thinking:"xhigh",
     role:"角色2", prompt:"{TOPIC}"},
    {id:"role3", model:"<按原则选择>", thinking:"xhigh",
     role:"角色3", prompt:"{TOPIC}"},
  ],
  options={
    debateRounds: {ROUNDS},
    synthesisModel: "<按原则选择综合模型>",
    synthesisThinking: "xhigh"
  }
)
```

## 变量

- `{TOPIC}`：讨论话题
- `{ROUNDS}`：辩论轮数（默认 2，建议 2-3）

## 结果

- 每个参与者每轮的观点
- 综合阶段的共识点、分歧点、最终建议
