# Multi-Ensemble — 多模型独立投票

调用 `multi_dispatch` 以 ensemble 策略让多个模型独立回答同一问题，再综合择优。

## 模型选择

先执行 `pi --list-models` 确认可用模型。选择 2-3 个不同类型的最强可用模型（如 deepseek + openai + anthropic 各一个），以最大化视角多样性。thinking 统一 `xhigh`。

## 执行

```
multi_dispatch(
  strategy="ensemble",
  tasks=[
    {id:"a", model:"<按原则选择>", thinking:"xhigh",
     prompt:"{QUESTION}"},
    {id:"b", model:"<按原则选择>", thinking:"xhigh",
     prompt:"{QUESTION}"},
    {id:"c", model:"<按原则选择>", thinking:"xhigh",
     prompt:"{QUESTION}"},
  ],
  options={
    synthesisModel: "<按原则选择综合模型>",
    synthesisThinking: "xhigh"
  }
)
```

## 变量

- `{QUESTION}`：待回答的问题

## 结果

- 各模型独立回答
- 综合阶段：识别共识、分析分歧、选出最佳答案
