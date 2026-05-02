# pi-multi-agent

[pi coding agent](https://github.com/badlogic/pi-mono) 的多模型并行调度扩展。

注册一个工具 — `multi_dispatch` — 让 LLM 自由调度多个子代理并行执行审查、辩论、接力或投票，每个子代理可指定不同模型和推理强度。

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

## 策略

| 策略 | 说明 | 后端 |
|---|---|---|
| `parallel` | 所有任务并发执行，互不依赖 | `print` |
| `debate` | 多轮交叉讨论，每轮各模型互读对方观点后回应，最后综合 | `rpc` |
| `chain` | A→B→C 顺序接力，每步接收上一步输出 | `rpc` |
| `ensemble` | 同一问题多模型独立回答，综合投票择优 | `print` |

## 后端

| 后端 | 机制 | 适用场景 |
|---|---|---|
| `print` | `pi --print` 子进程，单轮完成后退出 | 独立分析、投票 |
| `rpc` | `pi --mode rpc` 子进程，多轮有状态 | 辩论、接力 |

两种后端都是无头模式，结果自动返回给主会话 LLM。不含 tmux 或人工干预——多代理并行调度是自动化工作流。

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
| `tools` | string | ❌ | 逗号分隔的工具白名单 |

### options

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `debateRounds` | number | 2 | 辩论轮数（仅 debate） |
| `synthesisModel` | string | 首个任务的模型 | 综合阶段模型（debate/ensemble） |
| `synthesisThinking` | string | `high` | 综合阶段推理强度 |
| `executionMode` | string | 策略默认 | 强制指定后端：`print` / `rpc` |
| `taskTimeoutMs` | number | 300000 | 单任务超时（毫秒） |

## 使用示例

### 并行代码审查

```
multi_dispatch(
  strategy="parallel",
  tasks=[
    {id:"sec", model:"anthropic/claude-sonnet-4", thinking:"xhigh",
     prompt:"审查这个 diff 的安全问题：{DIFF}"},
    {id:"perf", model:"deepseek/deepseek-v4-pro", thinking:"xhigh",
     prompt:"审查这个 diff 的性能问题：{DIFF}"},
    {id:"arch", model:"openai/gpt-5.5", thinking:"xhigh",
     prompt:"审查这个 diff 的架构问题：{DIFF}"},
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

### 接力编码

```
multi_dispatch(
  strategy="chain",
  tasks=[
    {id:"impl", model:"openai/gpt-5.5", thinking:"xhigh",
     prompt:"在 src/auth.ts 中实现 JWT 鉴权中间件"},
    {id:"review", model:"anthropic/claude-sonnet-4", thinking:"xhigh",
     prompt:"审查上述实现的安全漏洞"},
    {id:"fix", model:"openai/gpt-5.5", thinking:"xhigh",
     prompt:"根据审查意见修复安全问题"},
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

## 项目配置

可选 `.pi-multi-agent/config.json`：

```json
{
  "strategyModes": {
    "parallel": "print",
    "debate": "rpc"
  },
  "taskTimeoutMs": 600000,
  "debateRounds": 3,
  "synthesisThinking": "xhigh"
}
```

## 设计原则

- **自动化优先**：子代理并行调度是全自动的，结果自动返回主会话，不需要人工干预
- **模型自由**：每个子代理独立指定模型和推理强度，充分发挥不同模型的互补优势
- **按策略选后端**：单轮用 `print`（简单快速），多轮用 `rpc`（有状态持续对话）
- **不含 tmux**：tmux 属于 pi 最佳实践中的人工干预场景（长时间任务、手动操作），不是多代理自动编排的组成部分

## License

MIT
