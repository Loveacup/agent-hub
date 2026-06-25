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

### CC lane（Phase 3a，只读 adapter，不碰 execute）

```
Hermes → call("cc-worker", "status", {})
Hermes → call("cc-worker", "discover", {})
Hermes → call("cc-worker", "publish_status", {})
  ↓
cc-worker 内部:
  1. 只读扫描 /tmp/cc-status-*、/tmp/cc-turn-done-*、tmux session 列表
  2. 优先读取 cc-tmux 写出的 status/heartbeat/turn-done 文件
  3. 必要时 fallback 到 cc-monitor.sh / tmux capture-pane
  4. 如果 observer 失败，标记 observer_error，不把 CC session 误判为失败
  5. NATS pub agent.cc.pool.status / agent.cc.<agent>.<topic>.<session>.status
```

Phase 3a 的关键约束：**wrap cc-tmux，只读状态，不实现 execute/interrupt/terminate**。`execute` 是 Phase 3b 单独 Spec，因为它涉及 send-keys、turn-done 归属、release 静默期与安全门。若包装层胶水复杂度超过直接使用 NATS 自建 Hub 的 2x，按止损线换轨。

### Codex lane（Phase 4a，exec backend 优先）

Codex 不走 cc-tmux，也不强行 PTY 化。Phase 4a 先只封装 `codex exec`：

```
Hermes → call("codex-worker", "exec", {
  prompt: "...",
  workdir: "/path/to/repo",
  sandbox: "read-only|workspace-write",
  ephemeral: true,
  output: "last-message"
})
  ↓
codex-worker 内部:
  1. iii-state: status = "running"
  2. codex exec --json --output-last-message --ephemeral
  3. 捕获 exit_code / stdout JSONL / last_message / duration / diff_summary
  4. 发布 agent.codex.<agent>.<topic>.<job>.status / turn-done / error
  5. return codex.result
```

Codex lane 的验收重点是：退出码、最终消息捕获、文件 diff、超时/取消、session 残留。`app-server` 只有在 exec 启动延迟、流式 event 或 thread affinity 明确成为瓶颈时才进入 Phase 4b。

### 事件通知（marker 轮询内化为 worker 事件）

```
旧: Stop hook → 写 /tmp/cc-turn-done-<s> → Hermes 主线程轮询

新: Stop hook → 仍写 /tmp/cc-turn-done-<s>（cc-tmux 第一真源不变）
    → cc-worker 本地检测 marker / status 文件
    → NATS pub agent.cc.<agent>.<topic>.<session>.turn-done
    → Hermes 事件消费层收到并异步处理
```

注意：轮询没有从系统里消失，只是从 Hermes 主线程迁移到 cc-worker；cc-tmux 仍保持零 NATS/iii 依赖。

## Worker 接口定义

### cc-worker

| Function | 参数 | 返回 | 说明 |
|----------|------|------|------|
| `status` | `{}` | `{kind, sessions[], ts}` | Phase 3a 只读状态 |
| `discover` | `{}` | `{sessions[], files[], ts}` | 只读发现 cc-tmux 产物 |
| `publish_status` | `{}` | `{published, payload}` | 发布 NATS status |
| `execute` | `{...}` | `{error:"not_implemented"}` | Phase 3a 禁止实现，Phase 3b 另开 Spec |
| `interrupt` | `{...}` | `{error:"not_implemented"}` | Phase 3a 禁止实现 |
| `terminate` | `{...}` | `{error:"not_implemented"}` | Phase 3a 禁止实现 |

### codex-worker

| Function | 参数 | 返回 | 说明 |
|----------|------|------|------|
| `exec` | `{prompt, workdir, sandbox, model?, ephemeral?}` | `{kind, exit_code, status, last_message, diff_summary}` | Phase 4a 单次非交互任务执行 |
| `status` | `{job_id?}` | `{jobs[], ts}` | 查询 active job 状态 |
| `retention_report` | `{}` | `{sessions_count, bytes, oldest, newest}` | 只读 Codex session retention 报告 |
| `cancel` | `{job_id}` | `{ack}` | 可选；取消正在运行的 Codex 任务 |
| `serve` | `{workdir}` | `{endpoint, pid}` | Phase 4b 可选 app-server 后端；必须有收益才保留 |

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
