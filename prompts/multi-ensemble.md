# Multi-Ensemble — 多模型独立投票

调用 `multi_dispatch` 以 ensemble 策略让多个模型独立回答同一问题，再综合择优。

## 执行

```
multi_dispatch(
  strategy="ensemble",
  tasks=[
    {id:"a", model:"openai/gpt-5.5-pro", thinking:"xhigh",
     prompt:"{QUESTION}"},
    {id:"b", model:"anthropic/claude-sonnet-4", thinking:"xhigh",
     prompt:"{QUESTION}"},
    {id:"c", model:"deepseek/deepseek-v4-pro", thinking:"xhigh",
     prompt:"{QUESTION}"},
  ],
  options={
    synthesisModel: "{SYNTHESIS_MODEL}",
    synthesisThinking: "xhigh"
  }
)
```

## 变量

- `{QUESTION}`：待回答的问题
- `{SYNTHESIS_MODEL}`：综合模型

## 结果

- 各模型独立回答
- 综合阶段：识别共识、分析分歧、选出最佳答案
