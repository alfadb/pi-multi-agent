# Multi-CSO — 并行多模型安全审计

调用 `multi_dispatch` 以不同模型并行执行安全审计的各个维度。

## 模型选择

先执行 `pi --list-models` 确认可用模型。每个维度按需求选择模型：

- 依赖审计、基础设施 → deepseek-v4-pro（结构化分析强）
- OWASP、STRIDE、LLM安全 → opus-4-7 或 gpt-5.5（推理最强）
- 数据分类 → 中强模型即可

无首选时自动降级。thinking 统一 `xhigh`。

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
