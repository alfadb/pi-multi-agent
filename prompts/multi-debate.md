# Multi-Debate — 多模型辩论讨论

调用 `multi_dispatch` 以 debate 策略让多个模型围绕一个话题进行多轮辩论。

## 模型选择

先执行 `pi --list-models` 确认可用模型。优选推理性最强的模型（opus 级别 > pro > 其他），每个角色尽量用不同模型以增加视角多样性。无首选时自动降级。thinking 统一 `xhigh`。

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
