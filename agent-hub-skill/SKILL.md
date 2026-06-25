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

**Phase 0-4c ✅**

- iii Engine v0.19.7 + NATS Server v2.x 已安装
- usage-worker / gc-worker / cc-worker / codex-worker 均已接入 iii
- codex-worker 已支持真实 `codex exec` spawn、stdout JSONL 捕获、last-message byte-match
- iii VM 内 Codex 出网需走宿主 Surge：worker 会把 `127.0.0.1:6152` 改写为 `100.96.0.1:6152`
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

## cc-worker host bridge（Phase 3b）

Phase 3b 引入 Host Bridge：iii VM 内 `cc-worker` 不直接碰宿主 `tmux`，而是通过 host-side bridge 调 cc-tmux scripts。核心约束：**实时监控是实时干预的前置条件**。

```bash
# 生产/常规启动：必须设置 token
export CC_HOST_BRIDGE_TOKEN="$(openssl rand -hex 24)"
node ~/code/agent-hub/agent-hub-skill/scripts/cc-host-bridge.mjs

# 仅本地 smoke，可显式允许无 token（不要常驻）
CC_HOST_BRIDGE_ALLOW_NO_TOKEN=1 node ~/code/agent-hub/agent-hub-skill/scripts/cc-host-bridge.mjs
```

Worker 默认从 VM 访问 `http://100.96.0.1:8767/control`，可用 `CC_HOST_BRIDGE_URL` 覆盖。

`iii worker restart cc-worker` 会重建 VM，需要 restart 后重新 provision token：

```bash
~/code/agent-hub/agent-hub-skill/scripts/provision-cc-bridge-token.sh
```

`cc::execute` 新建 session 时走 `cc-start.sh → cc-monitor.sh → cc-send.sh → cc-monitor.sh`。返回 `status: sent` 仅表示指令已送达，不代表任务完成；`lifecycle_state: sent_not_completed` 是强提醒。若 cc-start 检测到其它活跃 CC（exit 3），worker 返回 `active_sessions_require_ack`，不会自动 `--ack-active`。

可用 `cc::bridge_status` 检查 host bridge 是否在线、token 是否可用：

```bash
iii trigger cc::bridge_status --json '{}'
```

`cc::intervene` 会把干预内容写到持久 `/tmp/agent-hub-cc-intervention-<session>-<ts>.md`，避免 CC 延迟读取时 context 被提前删除。

安全契约：

- bridge 只接受 `execute / monitor / intervene / interrupt` 白名单动作。
- `intervene` 必须先 monitor；无监控证据时拒绝或自动先 monitor。
- `interrupt` 无 `confirm:true` + `reason` 必须拒绝。
- `kill` 不暴露。

## codex-worker 查询 / 真实执行

codex-worker 已支持真实 `codex exec`。首次启动或 `iii worker reinstall/clear` 后，VM 内没有 host Codex OAuth，需要临时 provision auth（不写入 git，不打印 token）：

```bash
~/code/agent-hub/agent-hub-skill/scripts/provision-codex-auth.sh
```

执行 smoke：

```bash
~/.local/bin/iii trigger codex::exec \
  --json '{"prompt":"Reply with exactly: agent-hub-ok","sandbox":"read-only","timeout_ms":300000}' \
  --address localhost \
  --port 49134 \
  --timeout-ms 330000
```

成功条件：

```json
{"kind":"codex.result","status":"succeeded","exit_code":0,"last_message":"agent-hub-ok","match_ok":true}
```

网络注意：iii VM 直连 OpenAI DNS 可能 timeout；worker 会默认注入 `HTTP_PROXY/HTTPS_PROXY=http://100.96.0.1:6152`。可用 `CODEX_WORKER_PROXY_URL` 覆盖，或设为 `direct` 禁用。

## 渐进迁移

Hermes 优先尝试 agent-hub。若 iii engine 未运行或 worker 不可用，回退 cc-tmux。

## 参考

- `references/architecture-v2.2.md` — 完整架构设计摘要
- `references/framework-comparison-20260625.md` — 全网调研：iii vs NATS vs Synadia vs Cotal
