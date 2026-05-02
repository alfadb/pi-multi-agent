# Multi-Review — 并行多模型代码审查

调用 `multi_dispatch` 以不同模型并行审查代码 diff。

## 前提

- 已获得完整的 git diff（`git diff origin/<base>`）
- 已确定需要触发哪些 specialist（根据触发条件判断）

## 模型选择原则

根据以下角色需求从当前可用模型中优选。无对应模型时自动降级。

| Specialist | 模型需求 | 首选 | 备选 |
|---|---|---|---|
| testing | 覆盖测试缺口需要结构化推理 | deepseek/deepseek-v4-pro | openai/gpt-5.5 |
| security | 安全审查需要最强的推理能力（opus级别 > sonnet > 其他） | anthropic/claude-opus-4-7 | deepseek-v4-pro |
| red-team | 对抗审查需要最强的推理 | openai/gpt-5.5-pro | anthropic/claude-opus-4-7 |
| maintainability | 可维护性审查，中等推理即可 | anthropic/claude-opus-4-7 | openai/gpt-5.5 |
| performance | 性能审查需要结构化推理 | deepseek/deepseek-v4-pro | openai/gpt-5.5 |
| api-contract | API 契约审查，中等推理 | openai/gpt-5.5 | deepseek-v4-pro |
| data-migration | 数据迁移审查，中等推理 | deepseek/deepseek-v4-pro | openai/gpt-5.5 |

thinking 等级:
- security/red-team → `xhigh`
- testing/performance → `xhigh`
- maintainability/api-contract/data-migration → `high`

## 执行

先执行 `pi --list-models` 确认当前可用模型，然后按上述原则选择模型，调用：

```
multi_dispatch(
  strategy="parallel",
  tasks=[
    {id:"testing", model:"<按原则选择>", thinking:"<按原则选择>",
     prompt:"严格遵循以下 checklist 审查这个 diff。每项发现标注严重度 [P0/P1/P2]、置信度 (N/10)、文件:行号。

—— checklist ——
{TESTING_CHECKLIST}

—— diff ——
{DIFF}"},

    {id:"security", model:"<按原则选择>", thinking:"<按原则选择>",
     prompt:"严格遵循以下 checklist 审查这个 diff 的安全问题。每项发现标注严重度、置信度、文件:行号。

—— checklist ——
{SECURITY_CHECKLIST}

—— diff ——
{DIFF}"},

    {id:"red-team", model:"<按原则选择>", thinking:"<按原则选择>",
     prompt:"以对抗视角审查这个 diff。假设代码作者犯了错误，找出所有可能被利用的漏洞、不变量违反、边界条件遗漏。每项发现标注严重度、置信度、文件:行号。

—— diff ——
{DIFF}"},

    {id:"maintainability", model:"<按原则选择>", thinking:"<按原则选择>",
     prompt:"严格遵循以下 checklist 审查这个 diff 的可维护性。每项发现标注严重度、置信度、文件:行号。

—— checklist ——
{MAINTAINABILITY_CHECKLIST}

—— diff ——
{DIFF}"},

    {id:"performance", model:"<按原则选择>", thinking:"<按原则选择>",
     prompt:"严格遵循以下 checklist 审查这个 diff 的性能问题。每项发现标注严重度、置信度、文件:行号。

—— checklist ——
{PERFORMANCE_CHECKLIST}

—— diff ——
{DIFF}"},

    {id:"api-contract", model:"<按原则选择>", thinking:"<按原则选择>",
     prompt:"严格遵循以下 checklist 审查这个 diff 的 API 契约问题。每项发现标注严重度、置信度、文件:行号。

—— checklist ——
{API_CONTRACT_CHECKLIST}

—— diff ——
{DIFF}"},

    {id:"data-migration", model:"<按原则选择>", thinking:"<按原则选择>",
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
