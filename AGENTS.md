# AGENTS.md · agent-hub

> **Canonical 架构参考。在本代码库工作前先读这里。**
> 分工：本文件 = 实现/架构权威；需求权威在 OB `02-Plan&CQI/agent-hub PRD.md`。

## 是什么

agent-hub = iii-powered agent hub for Hermes。用 iii Engine 作为 Hub 层，把 cc-tmux 的 CC 管理能力包装成 iii worker，提供 `call()` 接口。

**和 cc-tmux 的关系**：cc-tmux 是裸金属驱动层（tmux 操控、send-keys、freeze 检测、gate 脚本）。agent-hub 是上层 Hub，不改变 cc-tmux 一行代码——cc-tmux 保持零 iii 依赖。

## Core Principles

1. **iii 做 Hub，cc-tmux 做执行** —— 通信/状态/注册表归 iii，PTY 操控归 cc-tmux
2. **cc-tmux 零改动** —— agent-hub 只调用 cc-tmux 脚本，不修改它
3. **渐进迁移** —— Hermes 可同时使用 cc-tmux（文件通信）和 agent-hub（call 通信）
4. **止损在 Phase 3** —— 如果 cc-worker 对接成本 > NATS 自建，果断换轨

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
│       └── cc-worker/          # Phase 3: CC session 管理
├── hermes-skill/
│   └── SKILL.md                # Hermes agent-hub skill
└── tests/
    └── ...
```

## 路线图

| Phase | 内容 | 状态 |
|:--:|------|:--:|
| 0 | 装 iii + POC 验证 | ✅ |
| 1 | usage-worker · 替代 cc-usage.sh | 🔵 |
| 2 | gc-worker · 替代 cc-gc.sh | 🔵 |
| 3 | cc-worker · CC session 包成 worker | 🔵 |
| 4 | review-worker · 独立审计 | 🔵 |
| 5 | 全 Hub · 多 worker + 自动路由 | 🔵 |

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
