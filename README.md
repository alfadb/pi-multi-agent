# pi-multi-agent

[pi coding agent](https://github.com/badlogic/pi-mono) 的多模型并行调度扩展。

注册三个工具 — `multi_dispatch` / `vision` / `imagine` — 让 LLM 自由调度多个子代理（不同模型 + 不同推理强度）并行执行审查、辩论、接力或投票，并提供视觉理解和图像生成能力。

## 安装

```bash
pi install git:github.com/alfadb/pi-multi-agent
# 或 submodule
git submodule add https://github.com/alfadb/pi-multi-agent agent/skills/pi-multi-agent
```

配置 `settings.json`：

```json
{
  "extensions": [
    "~/.pi/agent/skills/pi-multi-agent/extensions/pi-multi-agent"
  ]
}
```

安装后 `/reload` 或重启 pi 即可使用。

## 架构：SDK-only

每个子代理任务 = 一次进程内 `completeSimple` 调用（可选带工具循环）。**不再使用子进程**——历史的 `print` / `rpc` backend 已删除。

| 维度 | 收益 |
|---|---|
| 0 子进程 | 不会产生孤儿进程；父 pi 退出，所有子任务自然终止 |
| 0 cwd 副作用 | 子任务不会触发父项目的 sediment / extension 等 cwd-bound 行为 |
| ESC 即时传播 | `ctx.signal` 直接送到 fetch；abort 延迟 ~10ms 量级 |
| Token 成本 | 每个任务直接拿到 `usage`，无需解析子进程 stdout |

## 策略

| 策略 | 说明 |
|---|---|
| `parallel` | 所有任务并发执行（Promise.all），互不依赖 |
| `debate` | 多轮交叉讨论，每轮各模型互读对方观点后回应，最后综合 |
| `chain` | A→B→C 顺序接力，每步接收上一步输出 |
| `ensemble` | 同一问题多模型独立回答，综合投票择优 |

## 参数

```
multi_dispatch(strategy, tasks[], options?)
```

### tasks[] 每项

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 唯一标识 |
| `model` | string | ✅ | `provider/modelId`，如 `"openai/gpt-5.5"` |
| `thinking` | string | ✅ | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` |
| `prompt` | string | ✅ | 发送给该子代理的提示词 |
| `role` | string | ❌ | 可读角色名（如 `"security-expert"`） |
| `tools` | string | ❌ | 逗号分隔的工具白名单（详见下文） |

#### tools 白名单

子代理工具受限以保证安全和可预测：

| 类别 | 名称 | 默认 |
|---|---|---|
| 只读 SDK 内置 | `read`, `grep`, `find`, `ls` | ✅ 允许 |
| **变更** SDK 内置 | `bash`, `edit`, `write` | ❌ **默认拒绝**，需 `PI_MULTI_AGENT_ALLOW_MUTATING=1` 才允许 |
| 别名 | `readonly` (= read+grep+find+ls) | ✅ |
| Multi-agent 自家 | `vision`, `imagine` | ✅ |
| **拒绝** | `multi_dispatch`（递归危险），第三方扩展工具（无安全的 ExtensionContext 转发） | — |

省略 `tools` 字段 = 纯推理任务（无工具）。

##### 为什么 `bash`/`edit`/`write` 默认禁用？

子代理没有用户确认流程。如果子代理模型被 prompt 注入（如读到含恶意指令的文件内容），会产生两个真实风险：

1. **RCE in cwd**—`bash` 在父项目根目录运行任意命令
2. **API key 泄露**—`bash` 继承父进程 env（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`...）并可 `curl` 到任意外部

只有在你完全信任子代理 prompt 来源时（例如全是你手写的 prompt，所有输入都可预期）才应该开。

### options

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `debateRounds` | number | 2 | 辩论轮数（仅 debate） |
| `synthesisModel` | string | 首个任务的模型 | 综合阶段模型（debate/ensemble） |
| `synthesisThinking` | string | `high` | 综合阶段推理强度 |
| `taskTimeoutMs` | number | 300000 | 单任务超时（毫秒） |

## 使用示例

> **关于以下示例中的模型名**
>
> 示例里出现的模型 id是占位符 `<provider/model>`，提醒你该到哪里填。实际使用时，主会话 LLM 会从 **pi-model-curator** 注入的 *Available models (curated)* 表中选择实际可用且合适的型号 —— 不要从本 README 拷具体型号名（如 README 与 curator 漂移，以 curator 为准）。

### 并行代码审查

```
multi_dispatch(
  strategy="parallel",
  tasks=[
    {id:"sec",  model:"<provider/model>", thinking:"xhigh",
     prompt:"审查这个 diff 的安全问题：{DIFF}", tools:"readonly"},
    {id:"perf", model:"<provider/model>", thinking:"xhigh",
     prompt:"审查这个 diff 的性能问题：{DIFF}", tools:"readonly"},
    {id:"arch", model:"<provider/model>", thinking:"xhigh",
     prompt:"审查这个 diff 的架构问题：{DIFF}", tools:"readonly"},
  ]
)
```

### 设计辩论

```
multi_dispatch(
  strategy="debate",
  tasks=[
    {id:"ceo", model:"<provider/model>", thinking:"xhigh",
     role:"CEO", prompt:"评估这个产品方案：{PROPOSAL}"},
    {id:"cto", model:"<provider/model>", thinking:"xhigh",
     role:"CTO", prompt:"评估这个产品方案：{PROPOSAL}"},
    {id:"cfo", model:"<provider/model>", thinking:"xhigh",
     role:"CFO", prompt:"评估这个产品方案：{PROPOSAL}"},
  ],
  options={debateRounds:3, synthesisModel:"<provider/model>"}
)
```

### 接力编码（带写权限 — 需环境变量 opt-in）

```bash
# 运行前需设置：
export PI_MULTI_AGENT_ALLOW_MUTATING=1
```

```
multi_dispatch(
  strategy="chain",
  tasks=[
    {id:"impl",   model:"<provider/model>", thinking:"xhigh",
     prompt:"在 src/auth.ts 中实现 JWT 鉴权中间件",
     tools:"read,edit,write"},
    {id:"review", model:"<provider/model>", thinking:"xhigh",
     prompt:"审查上述实现的安全漏洞", tools:"readonly"},
    {id:"fix",    model:"<provider/model>", thinking:"xhigh",
     prompt:"根据审查意见修复安全问题", tools:"read,edit,write"},
  ]
)
```

### 独立投票

```
multi_dispatch(
  strategy="ensemble",
  tasks=[
    {id:"a", model:"<provider/model>", thinking:"xhigh",
     prompt:"这个数据库选型方案有什么风险？"},
    {id:"b", model:"<provider/model>", thinking:"xhigh",
     prompt:"这个数据库选型方案有什么风险？"},
  ],
  options={synthesisModel:"<provider/model>"}
)
```

### 子代理调用 vision

```
multi_dispatch(
  strategy="parallel",
  tasks=[
    {id:"design-review", model:"<provider/model with image-in>",
     thinking:"high", tools:"vision,readonly",
     prompt:"用 vision 工具看 ./mockup.png，给出 UX 改进意见"},
  ]
)
```

## 项目配置

可选 `.pi-multi-agent/config.json`：

```json
{
  "taskTimeoutMs": 600000,
  "debateRounds": 3,
  "synthesisThinking": "xhigh",
  "visionModelPreferences": []
}
```

> 旧版本的 `strategyModes` / `extraPiFlags` 字段在 SDK-only 架构下已无意义，加载时会被忽略。

## 其他工具

### vision

`vision(prompt, imageBase64? | path?, mimeType?)` — 自动选最强可用视觉模型分析图像。配置 `visionModelPreferences` 可调整选择优先级。

### imagine

`imagine(prompt, model?, size?, quality?, style?)` — 通过 sub2api 调用 OpenAI gpt-image-2 / dall-e-3 生成图像，PNG 保存到项目 `.pi-multi-agent-output/`。

## 设计原则

- **自动化优先**：子代理并行调度全自动，结果自动返回主会话
- **模型自由**：每个子代理独立指定模型和推理强度，充分发挥不同模型的互补优势
- **进程内执行**：SDK-only — 不再 spawn 子进程，杜绝孤儿和 cwd 污染
- **安全的工具委派**：白名单制；子代理拿不到任意第三方扩展工具，不能递归调用 `multi_dispatch`，写/执行类工具默认禁用

## 限制

- `tasks.length` 上限 16（防止 prompt 注入导致 cost 爆炸 / rate-limit storm）
- 每任务 tool-calling 循环上限 50 轮（防止 runaway loop 烧光 timeout 预算）
- vision 工具的 `path` 参数限定在 `cwd` 内，且只接受图片扩展名（`.png/.jpg/.jpeg/.webp/.gif`）

## License

MIT
