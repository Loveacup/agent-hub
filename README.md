# agent-hub

> iii-powered agent hub for Hermes — 把 CC、Codex、OMP 等真实生产力 agent 包装成可观测、可调度的 worker lane，通过 `call()` 接口统一编排。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Tests](https://img.shields.io/badge/tests-492%2F492-brightgreen)

## 架构

```
Hermes (主频道助手)
  │
  ▼
agent-hub-skill (CLI 工具层)
  ├── run-cc-task.mjs        # 单任务调度
  ├── call-parallel.mjs      # 多 worker 并行 (H6)
  └── run-constraints.mjs    # Task5W2H 约束模型
  │
  ▼
iii Engine + NATS (控制面)
  │
  ├── cc-worker      ← 实时 PTY 会话管理 (wrap cc-tmux)
  ├── codex-worker   ← 无状态代码执行
  ├── review-worker  ← 独立审计 gate + 声明式路由
  ├── omp-worker     ← 跨 Hermes profile 生命周期管理
  ├── ssh-worker     ← 自有远程执行 (PoC)
  ├── usage-worker   ← 用量追踪
  └── gc-worker      ← Session GC
```

**核心设计原则：**
- **iii / NATS 只做控制面** — 通信、状态、注册、追踪归控制面；推理与产出归 CC / Codex
- **cc-tmux 零改动** — agent-hub 只调用 cc-tmux 脚本，不做 fork
- **Worker 声明式能力路由** — Vibeyard-inspired：worker 注册时声明 capabilities，routing 从能力推导行为（不硬编码 lane 名称）

## 路线图

| Phase | 内容 | 状态 |
|:--:|------|:--:|
| 0 | iii 安装 + POC | ✅ |
| 1 | usage-worker · 用量追踪 | ✅ |
| 2 | gc-worker · Session GC | ✅ |
| 3 | cc-worker · wrap cc-tmux | ✅ |
| 3b | cc-worker 实时控制 MVP | ✅ |
| 4 | codex-worker · Codex CLI lane | ✅ |
| 5 | Runtime Orchestrator · 单 session 编排 | ✅ |
| 6 | review-worker · gate + routing | ✅ |
| 7 | omp-worker · profile lifecycle | ✅ |
| 8 | ssh-worker · 自有远程执行 | 🟡 PoC |
| 9 | askills integration gate | ⬜ |

**已完成增强：**
- iii-sdk 升级 0.20.0 + 兼容层 `iii-compat.js`
- H6 多 worker 并行调度 (`call-parallel.mjs`)
- Worker Capability 声明式路由 (Vibeyard P0)
- `run-constraints.mjs` — Task5W2H 约束模型 (流马吸收)

## 核心能力

### 多 worker 并行 (H6)

```bash
# 同时调用 CC + Codex + Review，Promise.allSettled 错误隔离
cat > plan.json << 'EOF'
[
  {"lane":"cc","action":"execute","payload":{"task":"...","effort":"high"}},
  {"lane":"codex","action":"exec","payload":{"prompt":"plan this"}},
  {"lane":"review","action":"audit","payload":{"artifacts":["..."],"criteria":[]}}
]
EOF
node agent-hub-skill/scripts/call-parallel.mjs --plan plan.json
```

### 声明式 Worker 路由

```js
// 新 worker: 声明 capabilities 即可参与路由
defaultWorkerCatalog = {
  cc: { capabilities: ['realtime', 'monitor', 'intervene', 'code'] },
  codex: { capabilities: ['code', 'exec', 'stateless', 'monitor', 'intervene'] },
  review: { capabilities: ['danger_scan', 'verify', 'counter', 'gate'] },
  my-new-worker: { capabilities: ['monitor', 'intervene', 'remote'] }  // ← 零代码改动
}
```

### 约束模型 (Task5W2H)

```js
import { normalizeConstraints, validateConstraints, constraintSummary } from './lib/run-constraints.mjs';

const c = normalizeConstraints({ what: 'implement login', acceptance: ['passes tests'] });
const { valid, issues } = validateConstraints(c);
console.log(constraintSummary(c)); // 📋 implement login · ✅ 2 items
```

## 快速开始

```bash
# 安装依赖
cd iii/workers/cc-worker && npm install
cd ../codex-worker && npm install
cd ../review-worker && npm install
# ... (each worker independently)

# 启动 iii engine
iii --config iii/config.yaml

# 运行全量测试
node --test iii/workers/*/test/*.test.js agent-hub-skill/scripts/test/*.test.mjs
# → tests 492 · pass 492 · fail 0

# 调用 review worker 审核
echo '{"task":"scan this diff for dangerous commands","constraints":{"requires_review":true}}' | \
  iii call review-worker review --json
```

## 测试基线

| 模块 | 测试数 | 状态 |
|------|:--:|:--:|
| cc-worker | 52 | ✅ |
| codex-worker | 32 | ✅ |
| review-worker | 47 | ✅ |
| omp-worker | 111 | ✅ |
| ssh-worker | 80 | ✅ |
| usage / gc / shared | 157 | ✅ |
| agent-hub-skill (constraints/manifest/parallel) | 19 | ✅ |
| **合计** | **492** | ✅ |

## 相关资源

- 需求文档：[OB agent-hub PRD](https://github.com/Loveacup/agent-hub)
- 架构设计：[OB agent-hub 架构设计 v2.7](https://github.com/Loveacup/agent-hub)
- CC 驱动层：[cc-tmux](https://github.com/Loveacup/agent-hub) (零 iii 依赖)

## License

MIT
