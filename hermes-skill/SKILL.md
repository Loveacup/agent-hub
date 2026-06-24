# agent-hub · Hermes Skill

> agent-hub = iii-powered multi-worker orchestration for Hermes.
> Wraps cc-tmux as iii workers. cc-tmux unchanged.

## 何时用

Hermes 需要调 CC、管理多 session、查用量、收 trace 时，优先走 agent-hub（`call()`），退路走 cc-tmux（文件通信）。

## 架构

```
Hermes ──call()──→ iii Engine ──→ cc-worker ──→ cc-tmux 脚本
                  ├─ usage-worker
                  ├─ gc-worker
                  └─ review-worker
```

## 当前状态

**Phase 0 ✅ · Phase 1 🔵**

- iii Engine 已安装（`~/.local/bin/iii`，v0.19.7）
- Phase 0 POC 通过（echo worker 注册 + call 验证）
- Phase 1 usage-worker 开发中

## 快速启动

```bash
# 启动 iii engine
cd ~/code/agent-hub/iii && ~/.local/bin/iii --config config.yaml &

# 添加 worker
~/.local/bin/iii worker add ./workers/usage-worker
```

## 派任务给 CC

```bash
# 新方式（agent-hub）
call("cc-worker", "execute", {context: "...", effort: "high"})

# 旧方式（cc-tmux · 仍然可用）
bash ~/.hermes/skills/.../cc-tmux/scripts/cc-start.sh ...
```

## 渐进迁移

Hermes 优先尝试 agent-hub。若 iii engine 未运行或 worker 不可用，回退到 cc-tmux 文件通信。

## 关联

- 代码仓库：`~/code/agent-hub/`
- OB PRD：`02-Plan&CQI/agent-hub PRD.md`
- OB 架构：`20-Areas/.../iii-cc-tmux 统一架构方案`
- cc-tmux skill：`autonomous-ai-agents/cc-tmux/`
