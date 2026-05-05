# Multi-CSO — 并行多模型安全审计

调用 `multi_dispatch` 以不同模型并行执行安全审计的各个维度。

## 模型选择

参考系统提示中的 **Available models (curated)** 表格，按 hint 列匹配安全审计的不同维度：

- 结构化/列表型任务（依赖审计、基础设施检查）→选 hint 提到“structured analysis”或大上下文的推理型模型
- 深度推理型任务（OWASP、STRIDE、LLM 威胁建模）→选 hint 提到“strongest reasoning”或 opus 类模型
- 轻量分类（数据分类、事件打标）→选 sonnet/mini/flash 等中强模型

thinking 统一 `xhigh`；所选模型必须出现在当前 Available 表中。

## 执行

```
multi_dispatch(
  strategy="parallel",
  tasks=[
    {id:"deps", model:"<按原则选择>", thinking:"xhigh",
     prompt:"审查项目的依赖供应链安全。检查已知漏洞、过期依赖、供应链攻击面。

—— 项目信息 ——
{CONTEXT}

—— 依赖列表 ——
{DEPS}"},

    {id:"infra", model:"<按原则选择>", thinking:"xhigh",
     prompt:"审查基础设施安全。检查 Dockerfile、CI/CD 配置、网络暴露面、密钥管理。

—— 项目信息 ——
{CONTEXT}"},

    {id:"owasp", model:"<按原则选择>", thinking:"xhigh",
     prompt:"对项目进行 OWASP Top 10 评估。逐项检查，标注适用/不适用及原因。

—— 项目信息 ——
{CONTEXT}

—— 攻击面 ——
{ATTACK_SURFACE}"},

    {id:"stride", model:"<按原则选择>", thinking:"xhigh",
     prompt:"对项目进行 STRIDE 威胁建模。识别 Spoofing/Tampering/Repudiation/Info Disclosure/DoS/Elevation 威胁。

—— 项目信息 ——
{CONTEXT}

—— 架构 ——
{ARCHITECTURE}"},

    {id:"llm", model:"<按原则选择>", thinking:"xhigh",
     prompt:"审查 LLM/AI 相关安全风险。检查 prompt injection、输出信任边界、skill 供应链。

—— 项目信息 ——
{CONTEXT}"},

    {id:"data", model:"<按原则选择>", thinking:"xhigh",
     prompt:"审查数据分类和保护。识别 PII、密钥、敏感配置的数据流和存储位置。

—— 项目信息 ——
{CONTEXT}"},
  ]
)
```

## 变量

- `{CONTEXT}`：Phase 0-2 的完整输出（架构、攻击面、密钥扫描结果）
- `{DEPS}`：依赖文件内容（package.json 等）
- `{ATTACK_SURFACE}`：Phase 1 攻击面统计
- `{ARCHITECTURE}`：Phase 0 架构摘要

## 结果处理

1. 融合各维度发现到主审计输出
2. 去重交叉项（如依赖漏洞和 OWASP A6 重叠）
3. 严重度统一为 [CRITICAL/HIGH/MEDIUM/LOW]
