# macOS 安装与验证

适用于 Apple Silicon 和 Intel Mac。挂件是独立常驻桌面宠物，不绑定 Codex 桌面应用或 Codex CLI 的窗口；Codex 的打开、移动、最小化与退出不会影响它。

## 前置条件

- macOS 13 或更新版本。
- Node.js 24+ 与 npm 或 pnpm。入口优先查找 Homebrew Node（Apple Silicon `/opt/homebrew`，Intel `/usr/local`），也支持本机 Codex 已下载的 Node 运行时。
- 首次安装需要联网下载 Electron 44.3.0。

## 安装

在项目目录双击 `安装 Mac 开机自启.command`，或运行：

```bash
npm run install:mac
```

安装器会：

1. 优先使用 Homebrew 的 Node/npm 安装 Electron 到 `~/.codex/whale-widget/desktop-runtime`。
2. 给 Electron 使用独立的 `com.api-balance-whale.codex.desktop` 标识，避免与其他 Electron 应用共享“恢复窗口”状态。
3. 写入并启动 `~/Library/LaunchAgents/com.api-balance-whale.codex.plist`。
4. 向 `~/.codex/hooks.json` 添加小鲸鱼的 `PermissionRequest` 提醒 hook，不覆盖现有 hooks。

日常重新显示挂件时，优先双击项目根目录的 `启动桌面挂件.app`；它带有 Finder 图标。`启动桌面挂件.command` 仍保留为兼容入口。

安装完成后，挂件会独立显示在当前桌面，并在 macOS 的其他桌面空间中保持可见。关闭、最小化或退出 Codex 都不会影响它。使用托盘菜单或 `Cmd+Option+W` 可随时隐藏／显示。

## 待批准提醒

在 Codex CLI 中打开 `/hooks`，检查并信任小鲸鱼的 `PermissionRequest` hook。Codex 对新增或变更的 hook 要求人工信任；在信任之前不会运行。已打开的会话如果没有加载新 hook，可新建会话再试。

Codex 的受支持工具出现 `PermissionRequest` 人工审批事件时，小鲸鱼会持续显示“需要批准”提示，直到你点击气泡或鲸鱼。菜单里的“审批提醒音效”可独立开关，或选择预设、自定义音频片段及音效组；整体音量为零时仍保持静音。它只接收事件标记，不读取待执行命令或聊天内容，也不会代替你批准。未经过本机 hook 的云端请求及应用专有确认不在此提醒范围内。

已安装桌面挂件但缺少该 hook 时，可运行 `npm run install:approvals`；单独移除提醒可运行 `npm run uninstall:approvals`。完整卸载桌面挂件时也会移除这条 hook，并保留你自己的其他 hooks。

## 日常操作

- `启动桌面挂件.command`：启动或显示独立桌面挂件。
- `停止挂件服务.command`：停止当前挂件；之后可通过启动命令恢复。
- `停用开机自启.command`：停止并移除 LaunchAgent，保留设置、素材和账本。
- `Cmd+Option+W`：显示/隐藏挂件。

数据位于 `~/.codex/whale-widget`。源码安装在项目目录时，LaunchAgent 会直接引用该项目；如果移动目录，请重新运行安装器。

## 验证

```bash
node scripts/control.mjs status
node scripts/control.mjs balance
```

关键诊断文件：

- `supervisor-state.json`：LaunchAgent 监督器的心跳和 Electron 子进程 PID；挂件停止后 PID 为空，心跳照常更新。
- `macos-supervisor.log` 与 `macos-launchagent-error.log`：监督器和 Electron 输出。
- `desktop-error.json`：主进程异常；成功加载界面后会自动清除旧文件。

`follow-config.json`（桌面服务配置）和 `pause-until-host-exit.json`（停止标记）沿用早期跟随 Codex 窗口时的文件名。

挂件不会读取窗口位置、窗口标题或聊天内容，也不需要“辅助功能”权限。
