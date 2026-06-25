# agent-hub 架构设计

> 承自 `iii-cc-tmux 统一架构方案`（OB），本文是 agent-hub 的实现级架构。

## 分层

```
┌──────────────────────────────────────────┐
│              Hermes Agent                │
│   call("cc-worker", "execute", {...})    │
│   call("codex-worker", "exec", {...})    │
│   call("usage-worker", "check")          │
│   读 iii-state 获取所有 worker 状态       │
└────────────────┬─────────────────────────┘
                 │ call() / state query
┌────────────────▼─────────────────────────┐
│           iii Engine (控制面)            │
│  Live Catalog · Queue · State · Trace    │
│  ws://localhost:49134                    │
└────┬──────────┬──────────┬───────────────┘
     │          │          │          │
┌────▼───┐ ┌───▼─────┐ ┌──▼─────┐ ┌──▼──────┐
│  cc-   │ │ codex-  │ │ usage- │ │   gc-   │
│ worker │ │ worker  │ │ worker │ │ worker  │
└───┬────┘ └────┬────┘ └────────┘ └─────────┘
    │           │
    │           │ 内部调用 codex exec / app-server
    │           ▼
    │    ┌──────────────────────────────────┐
    │    │      Codex CLI（执行层）          │
    │    └──────────────────────────────────┘
    │ 内部调用 cc-tmux 脚本
    ▼
┌──────────────────────────────────────────┐
│         cc-tmux（执行层 · 不改）          │
│  cc-start / cc-send / cc-monitor         │
│  cc-finish / cc-watcher / gate/*.sh      │
└──────────────────────────────────────────┘
```

## 控制面 / 执行面边界

agent-hub 的目标不是自研新 agent，也不是让 iii/NATS/Kanban 替代工程 agent。边界如下：

| 层 | 组件 | 职责 | 不负责 |
|----|------|------|--------|
| 控制面 | iii Engine | worker catalog、函数调用、状态、trace | 代码推理、文件编辑 |
| 控制面 | NATS / JetStream | 跨 worker 事件、状态广播、可订阅日志 | 任务决策 |
| 控制面 | Kanban | 人工 gate、持久 handoff、跨 profile 调度 | 自动绕过人工确认 |
| 执行面 | cc-worker → cc-tmux | Claude Code 长会话、PTY、turn-done/freeze、gate | fork cc-tmux 或绕过其安全机制 |
| 执行面 | codex-worker → Codex CLI | 非 PTY 执行、流式 JSON、最终消息捕获、app-server 长服务 | 强行模拟 tmux 长会话 |

设计原则：CC 和 Codex 是主生产力 worker；usage/gc/review 等 worker 是辅助治理能力。控制面只负责编排、观测和止损。

## 核心通信链路

### CC lane（Phase 3，替代 cc-send.sh 文件通信）

```
Hermes → call("cc-worker", "execute", {
  context: "/tmp/task.md",
  effort: "high",
  model: "opus"
})
  ↓
cc-worker 内部:
  1. iii-state: status = "starting"
  2. bash cc-start.sh --effort high ...
  3. bash cc-send.sh --context /tmp/task.md ...
  4. while 未完成:
     - bash cc-monitor.sh → 解析状态 → emit 📡
     - 检测 turn-done / cc-freeze marker
  5. bash cc-finish.sh
  6. iii-state: status = "idle"
  7. return { result, artifacts }
  ↓
Hermes 收到返回值
```

Phase 3 的关键约束：wrap cc-tmux，不 fork、不改脚本、不绕过 gate。若包装层胶水复杂度超过直接使用 NATS 自建 Hub 的 2x，按止损线换轨。

### Codex lane（Phase 4）

Codex 不走 cc-tmux，也不强行 PTY 化。Phase 4 以两种后端封装同一个 worker lane：

```
Hermes → call("codex-worker", "exec", {
  prompt: "...",
  workdir: "/path/to/repo",
  sandbox: "workspace-write",
  output: "last-message"
})
  ↓
codex-worker 内部:
  1. iii-state: status = "running"
  2. 优先走 codex exec --json / --output-last-message
  3. 可选复用 Codex app-server，降低多次调用启动成本
  4. 发布 agent.codex.<id>.status / done / error
  5. return { result, artifacts, transcript }
```

Codex lane 的验收重点是：退出码、最终消息捕获、文件 diff、超时/取消，以及 app-server 模式是否真的比 `codex exec` 更值得维护。

### 事件通知（替代 marker 文件）

```
旧: Stop hook → 写 /tmp/cc-turn-done-<s> → Hermes 轮询

新: Stop hook → cc-worker 检测到 turn-done →
    call("hermes-worker", "turn-done", {session, artifacts})
    → Hermes 直接收到
```

## Worker 接口定义

### cc-worker

| Function | 参数 | 返回 | 说明 |
|----------|------|------|------|
| `execute` | `{context, effort, model}` | `{result, artifacts}` | 完整任务执行 |
| `status` | — | `{state, token, last_tool}` | 当前状态 |
| `interrupt` | `{message}` | `{ack}` | 安全干预 |
| `terminate` | — | `{ack}` | 安全终止 |

### codex-worker

| Function | 参数 | 返回 | 说明 |
|----------|------|------|------|
| `exec` | `{prompt, workdir, sandbox, model?}` | `{result, artifacts, transcript}` | 单次非交互任务执行 |
| `status` | `{id}` | `{state, last_event}` | 查询执行状态 |
| `cancel` | `{id}` | `{ack}` | 取消正在运行的 Codex 任务 |
| `serve` | `{workdir}` | `{endpoint, pid}` | 可选 app-server 后端；必须有收益才保留 |

### usage-worker

| Function | 参数 | 返回 | 说明 |
|----------|------|------|------|
| `check` | — | `{used, limit, remaining}` | 查当前用量 |
| `report` | `{period}` | `{summary}` | 历史用量报告 |

### gc-worker

| Function | 参数 | 返回 | 说明 |
|----------|------|------|------|
| `scan` | — | `{sessions[]}` | 全量扫描 |
| `plan` | `{sessions[]?}` | `{actions[]}` | 只产出清理计划，不执行 |
| `execute` | `{confirm, actions, confirmedActionIds?}` | `{executed[], skipped[]}` | 显式确认后执行清理 |

### review-worker

| Function | 参数 | 返回 | 说明 |
|----------|------|------|------|
| `audit` | `{artifacts, criteria}` | `{verdict}` | 跑 gate 脚本 |
| `verify` | `{command}` | `{output, exit_code}` | 独立取证 |
