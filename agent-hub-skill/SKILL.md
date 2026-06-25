---
name: agent-hub
description: >
  Multi-CLI agent hub for Hermes. Three-layer architecture: NATS (message backbone)
  + iii (worker runtime) + Hermes delegate_task bg (event consumption).
  Manages CC, Codex, and OMP sessions as iii workers over a unified NATS event bus.
  Use when: multi-agent tasks, unified state/trace, cross-worker events.
  Do NOT use for: single CC tasks (use cc-tmux directly).
type: routine
version: 0.2.0
author: Hermes Agent
license: Apache-2.0
---

# agent-hub · Multi-CLI Agent Hub

> 三层分工：NATS（消息骨干）+ iii（Worker 运行时）+ Hermes delegate_task bg（事件消费）
> 路线图：CC → Codex → OMP。cc-tmux 零改动。

## 架构

```
┌──────────────────────────────────────────┐
│           Hermes Agent                   │
│  delegate_task(bg) · NATS sub · iii call │
└──────┬──────────────┬────────────────────┘
       │ iii call()   │ NATS pub/sub
       ▼              ▼
┌──────────────┐  ┌─────────────────────────┐
│  iii Engine  │  │  NATS Server (4222)     │
│  Worker 管理 │  │  消息骨干               │
│  · Catalog   │  │  · agent.cc.*.status    │
│  · State     │  │  · agent.codex.*.status │
│  · Trace     │  │  · agent.omp.*.status   │
└──┬──┬──┬─────┘  │  · agent.usage.alert    │
   │  │  │        └──────────┬──────────────┘
   ▼  ▼  ▼                   │
┌──┐┌──┐┌──┐                 │ worker 也 pub/sub ─┘
│cc││cx││omp│  ← iii 管生命周期
│w ││w ││ w │  ← NATS 管通信
└─┬┘└──┘└───┘
  │ 调用 cc-tmux 脚本
  ▼
┌──────────────────────────────────────────┐
│       cc-tmux（裸金属 · 零改动）          │
└──────────────────────────────────────────┘
```

## 当前状态

**Phase 0 ✅ · Phase 1 🔵**

- iii Engine v0.19.7 + NATS Server v2.x 已安装
- Phase 0 POC 通过（iii 跨 worker call + NATS pub/sub）
- 代码仓库: `~/code/agent-hub/` · GitHub: `Loveacup/agent-hub`
- OB 文档: `20-Areas/20_技术项目/agent-hub/10_核心/`

## 路线图（6 Phase）

```
CC 基础层:  Phase 0 ✅ → Phase 1 🔵 usage → Phase 2 🔵 gc → Phase 3 🔵 cc ⛳
多 CLI 扩展: Phase 4 ⚪ codex → Phase 5 ⚪ omp
全 Hub:      Phase 6 ⚪ 多 CLI 并行 + review
```

- **⛳ Phase 3 止损线**：若 cc-worker 对接 iii 成本 > NATS 裸用的 2x，停用 iii、只用 NATS

## 何时用

| 场景 | 走 agent-hub | 走 cc-tmux 直连 |
|------|:--:|:--:|
| 单次 CC 任务 | — | ✅ 零开销 |
| 多 session 并行 | ✅ | ❌ |
| 用量追踪 & 告警 | ✅ usage-worker | — |
| Session GC | ✅ gc-worker | — |
| 跨 worker 事件通知 | ✅ NATS pub/sub | ❌ |
| Codex / OMP 会话管理 | ✅ Phase 4-5 | ❌ |

## NATS Subject 命名空间

| Subject | 发布者 | 订阅者 | 说明 |
|---------|--------|--------|------|
| `agent.cc.<id>.status` | cc-worker | Hermes | CC 状态变更 |
| `agent.cc.<id>.turn-done` | cc-worker | Hermes | CC 完成一轮 turn |
| `agent.cc.<id>.cmd` | Hermes | cc-worker | 向 CC 下发指令 |
| `agent.codex.<id>.*` | codex-worker | Hermes | Codex 会话（Phase 4） |
| `agent.omp.<id>.*` | omp-worker | Hermes | OMP 管线（Phase 5） |
| `agent.usage.alert` | usage-worker | Hermes | 用量告警 |
| `agent.gc.report` | gc-worker | Hermes | GC 扫描/计划报告 |
| `agent.state.*` | 任意 worker | 任意 worker | JetStream KV 共享状态 |

## 快速启动

```bash
# 1. NATS
~/code/agent-hub/nats-poc/nats-server -p 4222 -js &

# 2. iii Engine
cd ~/code/agent-hub/iii && ~/.local/bin/iii --config config.yaml &
```

## usage-worker 查询

Hermes 查用量必须走 agent-hub wrapper，不直接跑 `npx ccusage`：

```bash
~/code/agent-hub/agent-hub-skill/scripts/usage-check.sh
```

等价于：

```bash
~/.local/bin/iii trigger usage::check \
  --json '{}' \
  --address localhost \
  --port 49134 \
  --timeout-ms 30000
```

测试/集成时可注入 payload：

```bash
~/code/agent-hub/agent-hub-skill/scripts/usage-check.sh \
  '{"ccusageJson":{"daily":[{"date":"2026-06-25","totalTokens":1200}]},"envOverrides":{"CC_MAX_TOKENS":"1000"}}'
```

注意：usage-worker 运行在 iii VM 内，默认看不到宿主 Claude 日志；若 VM 内 `ccusage` 返回 `daily: []`，worker 会降级到 `totals.totalTokens` 并返回 warning。真实宿主用量采集后续应走 host-side collector 或日志挂载。

## gc-worker 查询

Hermes 查 GC 报告走 agent-hub wrapper；默认是 dry-run `gc::scan`，只报告 actions，不删除文件、不 kill 进程：

```bash
III_CONFIG=~/code/agent-hub/iii/config.yaml \
  ~/code/agent-hub/agent-hub-skill/scripts/gc-report.sh
```

等价于：

```bash
~/.local/bin/iii trigger gc::scan \
  --json '{}' \
  --address localhost \
  --port 49134 \
  --timeout-ms 30000
```

执行清理必须显式走 `gc::execute` 且传入 `confirm:true`；高风险 action 还需要 `confirmedActionIds` 精确确认：

```bash
GC_FUNCTION=gc::execute ~/code/agent-hub/agent-hub-skill/scripts/gc-report.sh \
  '{"confirm":true,"actions":[{"id":"delete_file:/tmp/cc-old","kind":"delete_file","path_or_pid":"/tmp/cc-old","risk":"low","reason":"stale","requires_confirm":false}]}'
```

## 渐进迁移

Hermes 优先尝试 agent-hub。若 iii engine 未运行或 worker 不可用，回退 cc-tmux。

## 参考

- `references/architecture-v2.2.md` — 完整架构设计摘要
- `references/framework-comparison-20260625.md` — 全网调研：iii vs NATS vs Synadia vs Cotal
