# 淘汰跟随 Codex 窗口的模式

挂件最初作为 Codex 桌面应用的伴随挂件，跟随 Codex 窗口移动：Windows 依赖 `desktop/WindowApi.cs`、`WhaleLauncher.cs` 与 `supervisor.ps1`，macOS 依赖 `desktop/macos/` 下的窗口探测与 supervisor。2026-09-30 决定不再保留这一模式，只保留独立桌面宠物（free-desktop）模式。跟随模式无法自动测试（冒烟测试只覆盖 `--free-desktop`），又让 `desktop/main.cjs` 充满平台与模式分支，并带来与 PowerShell、C# 共享的文件契约（`follow-config.json`、`pause-until-host-exit.json`）。后续重构直接删除跟随相关代码，不为它建立 seam。

Codex 仍是用量数据来源；淘汰的只是窗口跟随。删除时需要清理或迁移已安装用户的计划任务、LaunchAgent 和上述文件。

## 实施（2026-10-01）

- 计划任务、LaunchAgent 及其监督器仍负责登录时启动大肥鱼、意外退出后重新拉起；删去的只是窗口探测与跟随：`WindowApi.cs`、`window-probe.swift`、主进程里的宿主状态，以及本地通道的 `/internal/host` 路由。
- `follow-config.json` 和 `pause-until-host-exit.json` 保留原名，分别作为桌面服务配置和停止标记。安装器仍写入 `mode: free-desktop`，回退到旧版时也能按独立桌面方式运行。
- 已安装的电脑无需重装：监督器不再检查 `mode`，旧的跟随安装下次登录后即以独立桌面方式运行。只有跟随模式写下的文件（`follow-state.json`、`follow-input-error.json`、macOS 的窗口探针及其编译缓存）会在大肥鱼启动时删除。
- 用户入口“安装自动跟随”“停用自动跟随”改名为“安装开机自启”“停用开机自启”，并补上 Windows 的 `停用开机自启.cmd`。Windows 部分没有实机验证。
