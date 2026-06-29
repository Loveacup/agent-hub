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

### 2026-06-28 — worker SDK 升级至 0.20.0

- 变更：5 个 worker 的 `iii-sdk` 依赖 `0.19.x` → `^0.20.0`（仅 npm 包，详见 `iii/workers/shared/iii-compat.js`）
- 注意：本次升级**仅涉及 iii-sdk npm 包**，iii engine **二进制仍为 v0.19.7**（`~/.local/bin/iii`），SIGCHLD 僵尸根因尚未在引擎源码层修复
- 影响：退役条件 #1（引擎源码级 SIGCHLD 修复）**未满足**，僵尸监控 watchdog 继续保持运行

---

*本文件由 iii-zombie-watchdog.sh 自动追加*
2026-06-28 16:04:22 WARN: iii_pid=97120, zombies=4
2026-06-28 16:04:22 INFO: cleanup finished
2026-06-28 16:15:11 WARN: iii_pid=97120, zombies=5
2026-06-28 16:15:11 INFO: cleanup finished
2026-06-28 16:30:17 WARN: iii_pid=97120, zombies=5
2026-06-28 16:30:18 INFO: cleanup finished
2026-06-28 16:45:15 WARN: iii_pid=97120, zombies=5
2026-06-28 16:45:15 INFO: cleanup finished
2026-06-28 17:00:20 WARN: iii_pid=97120, zombies=5
2026-06-28 17:00:20 INFO: cleanup finished
2026-06-28 17:15:17 WARN: iii_pid=97120, zombies=5
2026-06-28 17:15:17 INFO: cleanup finished
2026-06-28 17:30:16 WARN: iii_pid=97120, zombies=5
2026-06-28 17:30:16 INFO: cleanup finished
2026-06-28 17:45:18 WARN: iii_pid=97120, zombies=5
2026-06-28 17:45:18 INFO: cleanup finished
2026-06-28 18:00:15 WARN: iii_pid=97120, zombies=5
2026-06-28 18:00:15 INFO: cleanup finished
2026-06-28 18:15:12 WARN: iii_pid=97120, zombies=5
2026-06-28 18:15:12 INFO: cleanup finished
2026-06-28 18:30:10 WARN: iii_pid=97120, zombies=5
2026-06-28 18:30:10 INFO: cleanup finished
2026-06-28 18:45:13 WARN: iii_pid=97120, zombies=5
2026-06-28 18:45:13 INFO: cleanup finished
2026-06-28 19:00:10 WARN: iii_pid=97120, zombies=5
2026-06-28 19:00:10 INFO: cleanup finished
2026-06-28 19:15:10 WARN: iii_pid=97120, zombies=5
2026-06-28 19:15:10 INFO: cleanup finished
2026-06-28 19:30:14 WARN: iii_pid=97120, zombies=5
2026-06-28 19:30:14 INFO: cleanup finished
2026-06-28 19:45:13 WARN: iii_pid=97120, zombies=5
2026-06-28 19:45:13 INFO: cleanup finished
2026-06-28 20:00:14 WARN: iii_pid=97120, zombies=5
2026-06-28 20:00:14 INFO: cleanup finished
2026-06-28 20:15:13 WARN: iii_pid=97120, zombies=5
2026-06-28 20:15:13 INFO: cleanup finished
2026-06-28 20:30:14 WARN: iii_pid=97120, zombies=5
2026-06-28 20:30:14 INFO: cleanup finished
2026-06-28 20:45:14 WARN: iii_pid=97120, zombies=5
2026-06-28 20:45:14 INFO: cleanup finished
2026-06-28 21:00:19 WARN: iii_pid=97120, zombies=5
2026-06-28 21:00:19 INFO: cleanup finished
2026-06-28 21:15:16 WARN: iii_pid=97120, zombies=5
2026-06-28 21:15:16 INFO: cleanup finished
2026-06-28 21:30:12 WARN: iii_pid=97120, zombies=5
2026-06-28 21:30:12 INFO: cleanup finished
2026-06-28 21:45:17 WARN: iii_pid=97120, zombies=5
2026-06-28 21:45:17 INFO: cleanup finished
2026-06-28 22:00:17 WARN: iii_pid=97120, zombies=5
2026-06-28 22:00:17 INFO: cleanup finished
2026-06-28 22:15:12 WARN: iii_pid=97120, zombies=5
2026-06-28 22:15:12 INFO: cleanup finished
2026-06-28 22:30:12 WARN: iii_pid=97120, zombies=5
2026-06-28 22:30:12 INFO: cleanup finished
2026-06-28 22:45:12 WARN: iii_pid=97120, zombies=5
2026-06-28 22:45:12 INFO: cleanup finished
2026-06-28 23:00:10 WARN: iii_pid=97120, zombies=5
2026-06-28 23:00:10 INFO: cleanup finished
2026-06-28 23:15:10 WARN: iii_pid=97120, zombies=5
2026-06-28 23:15:10 INFO: cleanup finished
2026-06-28 23:30:17 WARN: iii_pid=97120, zombies=5
2026-06-28 23:30:17 INFO: cleanup finished
2026-06-28 23:45:16 WARN: iii_pid=97120, zombies=5
2026-06-28 23:45:16 INFO: cleanup finished
2026-06-29 00:00:15 WARN: iii_pid=97120, zombies=5
2026-06-29 00:00:15 INFO: cleanup finished
2026-06-29 00:15:16 WARN: iii_pid=97120, zombies=5
2026-06-29 00:15:16 INFO: cleanup finished
2026-06-29 00:30:15 WARN: iii_pid=97120, zombies=5
2026-06-29 00:30:15 INFO: cleanup finished
2026-06-29 00:45:15 WARN: iii_pid=97120, zombies=5
2026-06-29 00:45:15 INFO: cleanup finished
2026-06-29 01:00:16 WARN: iii_pid=97120, zombies=5
2026-06-29 01:00:17 INFO: cleanup finished
2026-06-29 01:15:15 WARN: iii_pid=97120, zombies=5
2026-06-29 01:15:15 INFO: cleanup finished
2026-06-29 01:30:11 WARN: iii_pid=97120, zombies=5
2026-06-29 01:30:11 INFO: cleanup finished
2026-06-29 01:45:12 WARN: iii_pid=97120, zombies=5
2026-06-29 01:45:12 INFO: cleanup finished
2026-06-29 02:00:09 WARN: iii_pid=97120, zombies=5
2026-06-29 02:00:09 INFO: cleanup finished
2026-06-29 02:15:12 WARN: iii_pid=97120, zombies=5
2026-06-29 02:15:12 INFO: cleanup finished
2026-06-29 02:30:11 WARN: iii_pid=97120, zombies=5
2026-06-29 02:30:11 INFO: cleanup finished
2026-06-29 02:45:12 WARN: iii_pid=97120, zombies=5
2026-06-29 02:45:12 INFO: cleanup finished
2026-06-29 03:00:14 WARN: iii_pid=97120, zombies=5
2026-06-29 03:00:14 INFO: cleanup finished
2026-06-29 03:15:14 WARN: iii_pid=97120, zombies=5
2026-06-29 03:15:14 INFO: cleanup finished
2026-06-29 03:30:12 WARN: iii_pid=97120, zombies=5
2026-06-29 03:30:12 INFO: cleanup finished
2026-06-29 03:45:13 WARN: iii_pid=97120, zombies=5
2026-06-29 03:45:13 INFO: cleanup finished
2026-06-29 04:00:13 WARN: iii_pid=97120, zombies=5
2026-06-29 04:00:13 INFO: cleanup finished
2026-06-29 04:15:13 WARN: iii_pid=97120, zombies=5
2026-06-29 04:15:13 INFO: cleanup finished
2026-06-29 04:30:13 WARN: iii_pid=97120, zombies=5
2026-06-29 04:30:13 INFO: cleanup finished
2026-06-29 04:45:13 WARN: iii_pid=97120, zombies=5
2026-06-29 04:45:13 INFO: cleanup finished
2026-06-29 05:00:13 WARN: iii_pid=97120, zombies=5
2026-06-29 05:00:13 INFO: cleanup finished
2026-06-29 05:15:12 WARN: iii_pid=97120, zombies=5
2026-06-29 05:15:13 INFO: cleanup finished
2026-06-29 05:30:13 WARN: iii_pid=97120, zombies=5
2026-06-29 05:30:13 INFO: cleanup finished
2026-06-29 05:45:14 WARN: iii_pid=97120, zombies=5
2026-06-29 05:45:14 INFO: cleanup finished
2026-06-29 06:00:14 WARN: iii_pid=97120, zombies=5
2026-06-29 06:00:14 INFO: cleanup finished
2026-06-29 06:15:13 WARN: iii_pid=97120, zombies=5
2026-06-29 06:15:13 INFO: cleanup finished
2026-06-29 06:30:14 WARN: iii_pid=97120, zombies=5
2026-06-29 06:30:14 INFO: cleanup finished
2026-06-29 06:45:14 WARN: iii_pid=97120, zombies=5
2026-06-29 06:45:14 INFO: cleanup finished
2026-06-29 07:00:14 WARN: iii_pid=97120, zombies=5
2026-06-29 07:00:14 INFO: cleanup finished
2026-06-29 07:15:14 WARN: iii_pid=97120, zombies=5
2026-06-29 07:15:14 INFO: cleanup finished
2026-06-29 07:30:14 WARN: iii_pid=97120, zombies=5
2026-06-29 07:30:14 INFO: cleanup finished
2026-06-29 07:45:14 WARN: iii_pid=97120, zombies=5
2026-06-29 07:45:14 INFO: cleanup finished
2026-06-29 08:00:13 WARN: iii_pid=97120, zombies=5
2026-06-29 08:00:13 INFO: cleanup finished
2026-06-29 08:15:13 WARN: iii_pid=97120, zombies=5
2026-06-29 08:15:13 INFO: cleanup finished
2026-06-29 08:30:13 WARN: iii_pid=97120, zombies=5
2026-06-29 08:30:13 INFO: cleanup finished
2026-06-29 08:45:14 WARN: iii_pid=97120, zombies=5
2026-06-29 08:45:14 INFO: cleanup finished
2026-06-29 09:00:13 WARN: iii_pid=97120, zombies=5
2026-06-29 09:00:13 INFO: cleanup finished
2026-06-29 09:15:14 WARN: iii_pid=97120, zombies=5
2026-06-29 09:15:14 INFO: cleanup finished
2026-06-29 09:30:13 WARN: iii_pid=97120, zombies=5
2026-06-29 09:30:13 INFO: cleanup finished
2026-06-29 09:45:12 WARN: iii_pid=97120, zombies=5
2026-06-29 09:45:12 INFO: cleanup finished
2026-06-29 10:00:12 WARN: iii_pid=97120, zombies=5
2026-06-29 10:00:12 INFO: cleanup finished
2026-06-29 10:15:13 WARN: iii_pid=97120, zombies=5
2026-06-29 10:15:13 INFO: cleanup finished
2026-06-29 10:30:13 WARN: iii_pid=97120, zombies=5
2026-06-29 10:30:13 INFO: cleanup finished
2026-06-29 10:45:13 WARN: iii_pid=97120, zombies=5
2026-06-29 10:45:13 INFO: cleanup finished
2026-06-29 11:00:14 WARN: iii_pid=97120, zombies=5
2026-06-29 11:00:14 INFO: cleanup finished
2026-06-29 11:15:14 WARN: iii_pid=97120, zombies=5
2026-06-29 11:15:14 INFO: cleanup finished
2026-06-29 11:30:13 WARN: iii_pid=97120, zombies=5
2026-06-29 11:30:13 INFO: cleanup finished
2026-06-29 11:45:15 WARN: iii_pid=97120, zombies=5
2026-06-29 11:45:15 INFO: cleanup finished
2026-06-29 12:00:12 WARN: iii_pid=97120, zombies=5
2026-06-29 12:00:12 INFO: cleanup finished
2026-06-29 12:15:10 WARN: iii_pid=97120, zombies=5
2026-06-29 12:15:10 INFO: cleanup finished
2026-06-29 12:30:12 WARN: iii_pid=97120, zombies=5
2026-06-29 12:30:12 INFO: cleanup finished
2026-06-29 12:45:10 WARN: iii_pid=97120, zombies=5
2026-06-29 12:45:10 INFO: cleanup finished
2026-06-29 13:00:17 WARN: iii_pid=97120, zombies=5
2026-06-29 13:00:17 INFO: cleanup finished
2026-06-29 13:15:16 WARN: iii_pid=97120, zombies=5
2026-06-29 13:15:16 INFO: cleanup finished
