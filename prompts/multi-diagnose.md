# Multi-Diagnose — 多模型并行根因诊断

调用 `multi_dispatch` 以 ensemble 策略让多个模型独立诊断同一 bug，综合选出最可能的根因。

## 模型选择

先执行 `pi --list-models` 确认可用模型。**每个角色选择不同 provider 系列的最强模型**（anthropic: opus > sonnet, openai: pro > 普通, deepseek: pro > flash）。不足 3 个 provider 时从同一 provider 选不同模型。thinking 统一 `xhigh`。

## 执行

```
multi_dispatch(
  strategy="ensemble",
  tasks=[
    {id:"a", model:"<按原则选择>", thinking:"xhigh",
     prompt:"你是一个资深调试工程师。根据以下信息，独立分析这个 bug 的根因：

## 症状
{SYMPTOMS}

## 代码路径
{CODE_PATH}

## 最近变更
{RECENT_CHANGES}

## 复现步骤
{REPRO_STEPS}

请提供：
1. 根因假设（具体、可测）
2. 置信度 (1-10)
3. 验证方法（如何确认/排除）
4. 如果假设错误，下一个最可能的根因是什么"},

    {id:"b", model:"<按原则选择>", thinking:"xhigh",
     prompt:"你是一个资深调试工程师。独立分析以下 bug：

## 症状
{SYMPTOMS}

## 代码路径
{CODE_PATH}

## 最近变更
{RECENT_CHANGES}

## 复现步骤
{REPRO_STEPS}

请提供根因假设、置信度、验证方法、备选假设。"},

    {id:"c", model:"<按原则选择>", thinking:"xhigh",
     prompt:"你是一个资深调试工程师。独立分析以下 bug 的根因。

症状：{SYMPTOMS}
代码路径：{CODE_PATH}
最近变更：{RECENT_CHANGES}
复现步骤：{REPRO_STEPS}

给出根因假设、置信度、验证方法、备选。"},
  ],
  options={
    synthesisModel: "<按原则选择综合模型>",
    synthesisThinking: "xhigh"
  }
)
```

## 变量

- `{SYMPTOMS}`：错误信息、堆栈跟踪、现象描述
- `{CODE_PATH}`：从症状回溯的关键代码路径
- `{RECENT_CHANGES}`：最近变更（`git log --oneline -20`）
- `{REPRO_STEPS}`：复现步骤

## 结果

综合阶段输出：

1. **一致假设**（多个模型独立得出相同结论）→ 高置信度，直接进入验证
2. **分歧假设**（不同模型提出不同根因）→ 列出各方理由，按置信度排序
3. **唯一假设**（只有一个模型提出）→ 标注来源，评估合理后验证
