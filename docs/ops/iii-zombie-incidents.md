# iii engine 僵尸进程事件日志

> **阶段性运维记录** — 本 cron 为 iii engine v0.19.7 僵尸问题临时监控，退役条件：
> 1. iii 修复 SIGCHLD 处理（源码级修复），或
> 2. Phase 8 Slice 4 完成真实 SSH 集成后统一重构进程管理

## 事件记录

### 2026-06-28 — 首次部署

- 发现 iii engine PID 98380 名下 5 个僵尸子进程，最长僵死 3 天 4 小时
- 根因：iii v0.19.7 缺少 SIGCHLD 处理，fork 出的 worker 退出后未 waitpid 收割
- 处理：手动 kill engine → 重启 → 重新注册 worker
- 部署监控脚本：`~/.hermes/scripts/iii-zombie-watchdog.sh`
- 状态：监控中，每 15 分钟检测，超阈值自动回收

---

*本文件由 iii-zombie-watchdog.sh 自动追加*
2026-06-28 16:04:22 WARN: iii_pid=97120, zombies=4
2026-06-28 16:04:22 INFO: cleanup finished
