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

| 类别 | 名称 |
|---|---|
| SDK 内置 | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |
| 别名 | `readonly` (= read+grep+find+ls)，`coding` (= read+bash+edit+write+grep+find+ls) |
| Multi-agent 自家 | `vision`, `imagine` |
| **拒绝** | `multi_dispatch`（递归危险），第三方扩展工具（无安全的 ExtensionContext 转发） |

省略 `tools` 字段 = 纯推理任务（无工具）。

### options

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `debateRounds` | number | 2 | 辩论轮数（仅 debate） |
| `synthesisModel` | string | 首个任务的模型 | 综合阶段模型（debate/ensemble） |
| `synthesisThinking` | string | `high` | 综合阶段推理强度 |
| `taskTimeoutMs` | number | 300000 | 单任务超时（毫秒） |

## 使用示例

### 并行代码审查

```
multi_dispatch(
  strategy="parallel",
  tasks=[
    {id:"sec", model:"anthropic/claude-sonnet-4", thinking:"xhigh",
     prompt:"审查这个 diff 的安全问题：{DIFF}", tools:"readonly"},
    {id:"perf", model:"deepseek/deepseek-v4-pro", thinking:"xhigh",
     prompt:"审查这个 diff 的性能问题：{DIFF}", tools:"readonly"},
    {id:"arch", model:"openai/gpt-5.5", thinking:"xhigh",
     prompt:"审查这个 diff 的架构问题：{DIFF}", tools:"readonly"},
  ]
)
```

### 设计辩论

```
multi_dispatch(
  strategy="debate",
  tasks=[
    {id:"ceo", model:"openai/gpt-5.5-pro", thinking:"xhigh",
     role:"CEO", prompt:"评估这个产品方案：{PROPOSAL}"},
    {id:"cto", model:"anthropic/claude-sonnet-4", thinking:"xhigh",
     role:"CTO", prompt:"评估这个产品方案：{PROPOSAL}"},
    {id:"cfo", model:"deepseek/deepseek-v4-pro", thinking:"xhigh",
     role:"CFO", prompt:"评估这个产品方案：{PROPOSAL}"},
  ],
  options={debateRounds:3, synthesisModel:"openai/gpt-5.5"}
)
```

### 接力编码（带写权限）

```
multi_dispatch(
  strategy="chain",
  tasks=[
    {id:"impl", model:"openai/gpt-5.5", thinking:"xhigh",
     prompt:"在 src/auth.ts 中实现 JWT 鉴权中间件",
     tools:"coding"},
    {id:"review", model:"anthropic/claude-sonnet-4", thinking:"xhigh",
     prompt:"审查上述实现的安全漏洞", tools:"readonly"},
    {id:"fix", model:"openai/gpt-5.5", thinking:"xhigh",
     prompt:"根据审查意见修复安全问题", tools:"coding"},
  ]
)
```

### 独立投票

```
multi_dispatch(
  strategy="ensemble",
  tasks=[
    {id:"a", model:"openai/gpt-5.5", thinking:"xhigh",
     prompt:"这个数据库选型方案有什么风险？"},
    {id:"b", model:"deepseek/deepseek-v4-pro", thinking:"xhigh",
     prompt:"这个数据库选型方案有什么风险？"},
  ],
  options={synthesisModel:"openai/gpt-5.5"}
)
```

### 子代理调用 vision

```
multi_dispatch(
  strategy="parallel",
  tasks=[
    {id:"design-review", model:"openai/gpt-5.5",
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
  "visionModelPreferences": [
    "openai/gpt-5.5-pro",
    "anthropic/claude-opus-4-7"
  ]
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
- **安全的工具委派**：白名单制，子代理拿不到任意第三方扩展工具，也不能递归调用 `multi_dispatch`

## License

MIT
