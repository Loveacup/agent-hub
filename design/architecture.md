# agent-hub 架构设计

> 承自 `iii-cc-tmux 统一架构方案`（OB），本文是 agent-hub 的实现级架构。

## 分层

```
┌──────────────────────────────────────────┐
│              Hermes Agent                │
│   call("cc-worker", "execute", {...})    │
│   call("usage-worker", "check")          │
│   读 iii-state 获取所有 worker 状态       │
└────────────────┬─────────────────────────┘
                 │ call() / state query
┌────────────────▼─────────────────────────┐
│           iii Engine (Hub 层)            │
│  Live Catalog · Queue · State · Trace    │
│  ws://localhost:49134                    │
└────┬──────────┬──────────┬───────────────┘
     │          │          │
┌────▼───┐ ┌───▼────┐ ┌───▼──────┐
│  cc-   │ │ usage- │ │   gc-    │
│ worker │ │ worker │ │  worker  │
└───┬────┘ └────────┘ └──────────┘
    │
    │ 内部调用 cc-tmux 脚本
    ▼
┌──────────────────────────────────────────┐
│         cc-tmux（执行层 · 不改）          │
│  cc-start / cc-send / cc-monitor         │
│  cc-finish / cc-watcher / gate/*.sh      │
└──────────────────────────────────────────┘
```

## 核心通信链路

### 派发任务（替代 cc-send.sh 文件通信）

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
     - 检测 turn-done marker
  5. bash cc-finish.sh
  6. iii-state: status = "idle"
  7. return { result, artifacts }
  ↓
Hermes 收到返回值
```

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

### usage-worker

| Function | 参数 | 返回 | 说明 |
|----------|------|------|------|
| `check` | — | `{used, limit, remaining}` | 查当前用量 |
| `report` | `{period}` | `{summary}` | 历史用量报告 |

### gc-worker

| Function | 参数 | 返回 | 说明 |
|----------|------|------|------|
| `scan` | — | `{sessions[]}` | 全量扫描 |
| `gc` | — | `{reaped[]}` | 自动回收 |
| `reap` | `{session_id}` | `{ack}` | 回收单个 |

### review-worker

| Function | 参数 | 返回 | 说明 |
|----------|------|------|------|
| `audit` | `{artifacts, criteria}` | `{verdict}` | 跑 gate 脚本 |
| `verify` | `{command}` | `{output, exit_code}` | 独立取证 |
