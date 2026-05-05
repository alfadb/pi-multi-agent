# Multi-Ensemble — 多模型独立投票

调用 `multi_dispatch` 以 ensemble 策略让多个模型独立回答同一问题，再综合择优。

## 模型选择

参考系统提示中的 **Available models (curated)** 表格。**每个角色选择不同 provider 系列的推理型模型**（`reasoning: ✓`）以获得独立观点。如不足 3 个 provider，从同一 provider 选 hint 差异最大的多条。thinking 统一 `xhigh`。

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
