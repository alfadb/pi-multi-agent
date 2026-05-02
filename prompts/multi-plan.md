# Multi-Plan — 多模型规划协作

调用 `multi_dispatch` 以 debate 或 ensemble 策略进行多模型规划讨论。

## 模型选择

先执行 `pi --list-models` 确认可用模型。每个角色选择不同 provider 系列的最强模型（anthropic: opus > sonnet, openai: pro > 普通, deepseek: pro > flash）。thinking 统一 `xhigh`。

## 场景选择

### 产品讨论（office-hours）

用 debate 策略，不同角色（CEO/CTO/设计师/市场）挑战产品假设。

```
multi_dispatch(
  strategy="debate",
  tasks=[
    {id:"ceo", model:"<按原则选择>", thinking:"xhigh",
     role:"CEO", prompt:"评估这个产品方案的战略价值和市场风险：{PROPOSAL}"},
    {id:"cto", model:"<按原则选择>", thinking:"xhigh",
     role:"CTO", prompt:"评估这个产品方案的技术可行性和工程风险：{PROPOSAL}"},
    {id:"design", model:"<按原则选择>", thinking:"xhigh",
     role:"设计", prompt:"评估这个产品方案的用户体验和设计挑战：{PROPOSAL}"},
  ],
  options={
    debateRounds: {ROUNDS},
    synthesisModel: "<综合模型>",
    synthesisThinking: "xhigh"
  }
)
```

### 架构评审（plan-eng-review）

用 debate 策略，不同架构立场辩论。

```
multi_dispatch(
  strategy="debate",
  tasks=[
    {id:"pro", model:"<按原则选择>", thinking:"xhigh",
     role:"方案支持者", prompt:"为以下架构方案辩护，强调其优势：{PROPOSAL}"},
    {id:"con", model:"<按原则选择>", thinking:"xhigh",
     role:"方案挑战者", prompt:"挑战以下架构方案，找出弱点和风险：{PROPOSAL}"},
    {id:"alt", model:"<按原则选择>", thinking:"xhigh",
     role:"替代方案", prompt:"提出一个不同的架构方案来对比：{PROPOSAL}"},
  ],
  options={
    debateRounds: 2,
    synthesisModel: "<综合模型>",
    synthesisThinking: "xhigh"
  }
)
```

### 策略决策（plan-ceo-review / scope）

用 ensemble 策略，多个模型独立分析同一个决策，综合投票。

```
multi_dispatch(
  strategy="ensemble",
  tasks=[
    {id:"a", model:"<按原则选择>", thinking:"xhigh",
     prompt:"分析这个范围和策略选择，给出你的推荐：{QUESTION}"},
    {id:"b", model:"<按原则选择>", thinking:"xhigh",
     prompt:"分析这个范围和策略选择，给出你的推荐：{QUESTION}"},
    {id:"c", model:"<按原则选择>", thinking:"xhigh",
     prompt:"分析这个范围和策略选择，给出你的推荐：{QUESTION}"},
  ],
  options={
    synthesisModel: "<综合模型>",
    synthesisThinking: "xhigh"
  }
)
```

## 变量

- `{PROPOSAL}` / `{QUESTION}`：待讨论的方案或决策
- `{ROUNDS}`：辩论轮数（默认 2）
