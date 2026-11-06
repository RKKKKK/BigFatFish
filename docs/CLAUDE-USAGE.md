# Claude 订阅额度接入

大肥鱼通过 Claude Code 官方 `statusLine` 接收 Pro/Max 订阅的 5 小时和 7 天额度快照，并通过官方 `Stop` hook 接收主会话的回复完成事件。只保存两组已用百分比、重置时间、采样时间，以及完成事件的时间和随机 ID；不保存 Claude 输入、回复、会话路径、账号或认证数据。任务小窗另用几个 hooks 和同一个状态栏记下每个会话的文件夹、状态和 token 数，见 [任务小窗](AGENTS.md#数据从哪来)。参考：[状态栏字段](https://code.claude.com/docs/en/statusline#available-data)和[Stop hook](https://code.claude.com/docs/en/hooks#stop)。

## 安装与使用

在额度管理的“账户”页点“接入 Claude Code”，或在 macOS 已安装 Claude Code 的机器上执行 `node scripts/configure-claude-statusline.mjs install`。两者都解析并原子更新 `~/.claude/settings.json`，保留其他字段和已有 hooks；若已有非大肥鱼的 `statusLine` 命令，则拒绝覆盖。“移除接入”或 `node scripts/configure-claude-statusline.mjs uninstall` 只移除大肥鱼自己的状态栏和 hooks。早先只装了 `Stop` hook 的接入会显示“更新接入”，更新时旧的 `claude-stop.mjs` 换成 `claude-hook.mjs`。机器上没有独立的 Node 时，命令改用桌面应用自带的运行时。

Claude 收到回复并刷新状态栏时，会把 JSON 送给 `scripts/claude-statusline.mjs`。该脚本写入挂件数据目录中的 `claude-subscription.json`，并在 Claude 终端状态栏显示简短剩余额度。主会话回复完成后，`scripts/claude-hook.mjs`（早先的接入是 `scripts/claude-stop.mjs`）写入 `claude-last-turn.json`；挂件弹出“Claude 回复完成”及额度，并使用现有任务结束音效设置。Claude 的回复完成算作 Claude 订阅的活动，挂件因此切到 Claude 的额度；规则见 [当前额度](QUOTA.md#当前额度)。挂件只重读本地快照，不向 Claude 发起新的请求。配置生效前已完成的回复不会补发提示。

`GET /api/claude/subscription` 返回已验证的百分比、ISO 重置时间及采样时间；`GET /api/claude/last-turn` 返回不含会话正文的完成事件。每个额度窗口独立处理：缺失显示 `--`，重置后不继续显示过期值；两个窗口都缺失时显示待更新。不带额度的推送（例如首个回复之前）不会覆盖已有的窗口；只带一个窗口时，另一个保留到它重置。Claude 日志中的 token 数不用于推算账户剩余额度。

状态栏可能在首个模型回复之前没有额度，也可能在 Claude 关闭后停留在最后一次快照。采样时间只代表 Claude 将数据交给脚本的时间，并非账户服务端的实时更新时间；其他设备发生的使用可能延后显示。状态栏脚本不走大肥鱼的网络代理，也无需访问 Claude 登录凭据。

验证入口：`node --test tests/claude-usage.test.mjs tests/usage-client.test.mjs tests/usage-presentation.test.mjs`、`npm test`、`npm run check`、`npm run test:desktop`。测试使用合成额度；真实额度需在 Claude 自然完成一轮回复后，与 Claude 的 `/usage` 对照。
