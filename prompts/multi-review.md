# Multi-Review — 并行多模型代码审查

调用 `multi_dispatch` 以不同模型并行审查代码 diff。

## 前提

- 已获得完整的 git diff（`git diff origin/<base>`）
- 已确定需要触发哪些 specialist（根据触发条件判断）

## 执行

```
multi_dispatch(
  strategy="parallel",
  tasks=[
    {id:"testing", model:"deepseek/deepseek-v4-pro", thinking:"xhigh",
     prompt:"严格遵循以下 checklist 审查这个 diff。每项发现标注严重度 [P0/P1/P2]、置信度 (N/10)、文件:行号。

—— checklist ——
{TESTING_CHECKLIST}

—— diff ——
{DIFF}"},

    {id:"security", model:"anthropic/claude-opus-4-7", thinking:"xhigh",
     prompt:"严格遵循以下 checklist 审查这个 diff 的安全问题。每项发现标注严重度、置信度、文件:行号。

—— checklist ——
{SECURITY_CHECKLIST}

—— diff ——
{DIFF}"},

    {id:"red-team", model:"openai/gpt-5.5-pro", thinking:"xhigh",
     prompt:"以对抗视角审查这个 diff。假设代码作者犯了错误，找出所有可能被利用的漏洞、不变量违反、边界条件遗漏。每项发现标注严重度、置信度、文件:行号。

—— diff ——
{DIFF}"},

    {id:"maintainability", model:"anthropic/claude-opus-4-7", thinking:"high",
     prompt:"严格遵循以下 checklist 审查这个 diff 的可维护性。每项发现标注严重度、置信度、文件:行号。

—— checklist ——
{MAINTAINABILITY_CHECKLIST}

—— diff ——
{DIFF}"},

    {id:"performance", model:"deepseek/deepseek-v4-pro", thinking:"xhigh",
     prompt:"严格遵循以下 checklist 审查这个 diff 的性能问题。每项发现标注严重度、置信度、文件:行号。

—— checklist ——
{PERFORMANCE_CHECKLIST}

—— diff ——
{DIFF}"},

    {id:"api-contract", model:"openai/gpt-5.5", thinking:"high",
     prompt:"严格遵循以下 checklist 审查这个 diff 的 API 契约问题。每项发现标注严重度、置信度、文件:行号。

—— checklist ——
{API_CONTRACT_CHECKLIST}

—— diff ——
{DIFF}"},

    {id:"data-migration", model:"deepseek/deepseek-v4-pro", thinking:"high",
     prompt:"严格遵循以下 checklist 审查这个 diff 的数据迁移问题。每项发现标注严重度、置信度、文件:行号。

—— checklist ——
{DATA_MIGRATION_CHECKLIST}

—— diff ——
{DIFF}"},
  ]
)
```

## 结果处理

1. **去重**：多个 specialist 报告相同发现 → 保留置信度最高的版本
2. **交叉确认 boost**：同一发现被 ≥2 个不同模型报告 → 置信度 +2
3. **矛盾标注**：不同模型对同一位置有相反判断 → 标注 `[MODEL-DISAGREE]`，列出各自立场
4. **合并到主审查**：将所有发现合并到主审查输出中，标注 specialist 来源
