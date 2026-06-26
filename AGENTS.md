# AGENTS.md · agent-hub

> **Canonical 架构参考。在本代码库工作前先读这里。**
> 分工：本文件 = 实现/架构权威；需求权威在 OB `20-Areas/20_技术项目/agent-hub/10_核心/agent-hub PRD.md`，路线图权威在 OB `20-Areas/20_技术项目/agent-hub/10_核心/agent-hub 路线图.md`。

## 是什么

agent-hub = iii-powered agent hub for Hermes。用 iii Engine 作为 Hub 层，把 CC、Codex 等真实生产力 worker 包装成可观测、可调度的 worker lane，提供 `call()` 接口。

**和 cc-tmux 的关系**：cc-tmux 是裸金属驱动层（tmux 操控、send-keys、freeze 检测、gate 脚本）。agent-hub 是上层 Hub，不改变 cc-tmux 一行代码——cc-tmux 保持零 iii 依赖。

## Core Principles

1. **iii / NATS / Kanban 只做控制面** —— 通信、状态、注册表、追踪和人工 gate 归控制面；实际推理与产出归 CC / Codex 等 worker lane
2. **CC 与 Codex 是主生产力 worker** —— Phase 3 先把 cc-tmux 包成 cc-worker；Phase 4 再用 `codex exec` / app-server 包成 codex-worker
3. **实时控制是所有 CLI agent lane 的硬契约** —— 每个生产力 lane 必须有 `execute + monitor + intervene + gated interrupt + event`；不支持热输入时必须显式返回 unsupported 和替代策略
4. **cc-tmux 零改动** —— agent-hub 只调用 cc-tmux 脚本，不修改它
5. **渐进迁移** —— Hermes 可同时使用 cc-tmux（文件通信）、Codex CLI 和 agent-hub（call 通信）
6. **止损在 Phase 3** —— 如果 cc-worker 对接成本 > NATS 自建，果断换轨

## 目录结构

```
agent-hub/
├── README.md
├── AGENTS.md                   # 本文件
├── design/
│   └── architecture.md         # 架构设计
├── iii/
│   ├── config.yaml             # iii engine 配置
│   └── workers/
│       ├── usage-worker/       # Phase 1: 用量追踪
│       ├── gc-worker/          # Phase 2: Session GC
│       ├── cc-worker/          # Phase 3: CC session 管理（wrap cc-tmux，无 fork）
│       └── codex-worker/       # Phase 4: Codex exec/app-server lane
├── agent-hub-skill/
│   └── SKILL.md                # Hermes agent-hub skill
└── tests/
    └── ...
```

## 路线图

> 路线图权威：OB `10_核心/agent-hub 路线图.md`。本表为代码库内嵌快照。

| Phase | 内容 | 状态 |
|:--:|------|:--:|
| 0 | 装 iii + POC 验证 | ✅ |
| 1 | usage-worker · 替代 cc-usage.sh | ✅ |
| 2 | gc-worker · 替代 cc-gc.sh | ✅ |
| 3 | cc-worker · wrap cc-tmux（不 fork） | ✅ |
| 3b | cc-worker 实时控制 MVP（execute/monitor/intervene/watcher） | ✅ |
| 4 | codex-worker · Codex `codex exec` lane | ✅ |
| 5 | Runtime Orchestrator · 单 CC session 编排（run manifest + watcher + suggestion routing + evidence archive）★ Alex 核心诉求 | ✅ MVP slices 1-6 + fake E2E smoke |
| 6 | omp-worker + review-worker + 多 CLI routing | ⬜ |
| 7 | ssh-worker PoC · 自有远程执行（不依赖 askills） | ⬜ |
| 8 | askills integration gate · 治理增强（只读 preflight） | ⬜ |

## Worker lane 分工

| Lane | 执行引擎 | agent-hub 职责 | 禁止事项 |
|------|----------|----------------|----------|
| `cc-worker` | cc-tmux + Claude Code | 统一 session 生命周期、状态事件、turn-done/freeze 转译、gate 结果回传 | 不 fork / 不改 cc-tmux；不绕过 cc-tmux 的安全门控 |
| `codex-worker` | Codex CLI `codex exec` / app-server | 非 PTY 执行、流式状态、stdout JSONL 捕获、最终消息 byte-match、取消与超时治理 | 不强塞 tmux；不把 Codex 变成长期 PTY session |
| `usage-worker` / `gc-worker` | 本地脚本 + iii | 用量/GC 辅助能力 | 不承担主任务执行 |

控制面边界：iii 负责 worker catalog / call / trace，NATS 负责跨 worker event bus，Kanban 负责人类 gate 和 durable handoff。它们不替代 CC/Codex 的推理与工程执行能力。

## 止损线（Phase 3 go/no-go）

把真实 CC session 包成 cc-worker 时，若对接成本 > 直接用 NATS 自建 Hub，则换轨。判断标准：
- cc-worker 的生命周期管理代码行数
- 与 cc-start/send/monitor/finish 的胶水代码复杂度
- iii engine 的资源占用（CPU/内存）

## 工作约定

- TDD：实现类先写测试
- cc-tmux 脚本路径：`~/.hermes/skills/autonomous-ai-agents/cc-tmux/scripts/`
- iii engine 路径：`~/.local/bin/iii`
- worker 优先用纯 JS + `node:test` 起步，除非进入复杂类型边界再升 TypeScript
- npm 依赖新增需显式留账；`iii-sdk` 版本先贴 iii engine 大版本
