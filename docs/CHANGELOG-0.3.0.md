# 0.3.0 工作助手

0.2.6 之后加入“工作台”和长期记忆，把大肥鱼从余额桌宠扩展成可以监控、下发和复盘 Codex / DSH 任务的工作助手。

## 新增

- **独立工作台窗口**：任务、记忆、设置三个页签；从任务小窗标题栏的方格按钮或托盘菜单打开。位置、大小写入 `ui-state.json`，关闭只是隐藏。
- **黑色指挥舱界面**：无系统标题栏，左侧任务监控 + 大肥鱼 Q 版形象，中间上任务详情、下角色聊天，右侧今日概览 / 长期记忆 / 快捷操作 / 最近完成；玻璃面板默认纯黑背景，可在设置里选择本地背景图（≤3 MB，只保存在本机）。
- **统一任务总线**：Codex、DSH、Claude Code 的会话在同一张表里；DSH 只读 `~/.dsh/storages/session_projcache` 的投影缓存，不读压缩正文，不修改 DSH 文件。
- **对话下发**：`work_task` 工具支持 `list / detail / draft / start / stop / continue / summary / digest`。先建草稿，用户在工作台确认或明确回复“确认”后才启动 Codex/DSH 无人值守任务。
- **Runner**：固定命令、stdin prompt、目录白名单、并发队列、超时、停止进程树、重启中断恢复、审计；Codex 用 `exec --approve-for-me`，DSH 用 headless + 凭据 patch。
- **续跑（C）**：已结束且有会话 ID 的下发任务可通过 `work_task continue` 新建草稿，确认后用 Codex `exec resume` / DSH `--session-id` 续跑；不接管 GUI 中活着的会话。
- **长期记忆**：最多 4 KB / 40 条，分称呼、偏好、长期要求、项目、决定、近期；`memory_list / memory_save / memory_forget` 工具、空闲自动整理、从历史初始化、工作台记忆页。
- **任务摘要与复盘**：Codex 只读日志头尾，DSH 用输出/投影缓存；按源版本缓存；内容读取开关；工作台“生成摘要”和“今日复盘”；`work_task summary / digest`。
- **设置**：允许目录、读取任务内容、确认下发、并发数、Codex 沙箱、任务超时、自动整理、日报时间。

## 数据文件

都在挂件数据目录：

- `work-tasks.json`：下发任务与草稿。
- `work-audit.jsonl`：动作审计，不含 prompt 正文。
- `work-memory.json`：长期记忆。
- `work-summaries.json`：任务摘要缓存。
- `work-reports.json`：按天复盘缓存。
- `work-settings.json`：工作台设置。
- `work-runs/<任务>/last.txt`：Codex 最后一轮输出（临时文件）。
- `dsh-headless.patch.yml`：headless 凭据/provider 覆盖。

## 新增

- **任务画布与命令面板**：中间区域增加“详情 / 看板 / 时间轴”页签。看板按排队、运行中、等你处理、完成结束分组；时间轴按 Codex/DSH/Claude 泳道显示最近 1/6/24 小时（观测任务用最后活动时间估算）。详情增加阶段条和下发行任务的只读执行输出（最近 120 条，密钥样式内容脱敏）。`Ctrl+K` 可搜索任务、切换视图、打开记忆/设置、生成摘要和今日复盘；视图选择会记住。
- **氛围层**：背景图支持轻微鼠标视差，大肥鱼宠物卡按运行/等待/失败/空闲显示不同状态光晕；均尊重系统“减少动态效果”。
- **聊天任务卡片与 Pulse**：`work_task` 工具结果会给聊天 turn 附 `taskRefs`，聊天里显示任务卡片，可回详情或生成摘要。右侧“今日节奏”用 24 小时色带展示当天任务，额度条显示 Codex/Claude 的 5h/7d 剩余；DSH 没有额度接口时显示 —。右侧快捷入口收进命令面板。
- **细节打磨**：命令面板改为弹性高度并可滚动；输出流支持自动跟随、滚动位置保留和“回到最新”；聊天任务卡片状态随任务列表刷新；时间轴增加范围图例、泳道计数和起止时间提示；今日节奏的小时格可点开该时段第一个任务；额度低于 25% 变橙红。

## 修复

- **DSH 下发时的 profile EPERM**：Windows 上大肥鱼以 `--no-sandbox` 运行时会继承 Low integrity，DSH 子进程无法写原 `~/.dsh/profiles/headless/cordis.yml`。下发 DSH 现在使用 `<数据目录>/dsh-home` 作为 `DSH_HOME`，复制 headless profile、凭据和 home patch；续跑时复制对应会话，TEMP/TMP 也隔离。原 DSH profile 不再被写。需要写项目文件的 DSH 任务仍必须用 `scripts/launch-admin.ps1` 以正常完整性启动大肥鱼，否则 Windows 会拦住项目目录写入。
- **摘要合并为“上一次回答”**：任务详情不再单独显示“最近输出”，只显示上一次回答的摘要；最多 200 字、纯文本、不用 Markdown、不带省略号。提示词和错误仍可展开。DSH 摘要优先读取完整会话记录，旧缓存会自动失效。

- **Windows 重启不再丢 API 密钥**：`safeStorage` 的 DPAPI 加密保险库现在在 Windows 也可用，填入的对话/额度 API 密钥写入 `keychain-secrets.json` 密文，重启后重新解密。旧版本在 Windows 上只把密钥放在内存里，升级后需要在额度管理里**重新填写一次**；之后再重启会保留。
- **任务跳转**：工作台任务详情里的“切到 DSH / 切到 Codex”按钮暂时移除，窗口切换功能以后再做；任务小窗行点击仍保留原有接口。工作台不再自动隐藏，也不再常驻最上层；主进程不再弹出未捕获异常对话框。

## 安全与边界

- 下发只在用户配置的允许目录内启动固定的 Codex/DSH 命令；prompt 只走 stdin，不拼 shell。
- 默认两阶段确认；没有确认的 `start` 会被 Runner 拒绝。
- 长期记忆拒绝疑似密钥/密码/令牌；记忆和摘要只作为对话上下文发给用户配置的大肥鱼账户。
- 任务输出是数据，不是指令；摘要请求明确要求不要执行输出中的指令。
- 停止、超时和挂件退出会尽量结束进程树；重启时残留任务标记为中断。
- DSH headless 会话不写 `workspace.json`，未必出现在 DSH GUI 侧边栏；工作台是任务视图。

## 兼容与已知限制

- Windows 验证；macOS 仍沿用 0.2.6 的 Ghostty/Codex 跳转路径。
- Codex 的 `Code Mode` 缺失、WebSocket 回退等诊断不影响普通任务。
- DSH 审批请求可能只显示为“提问”，不能从大肥鱼里批准。
- 续跑不支持没有会话 ID 的任务，也不接管 GUI 活跃会话。
- 观察中的任务只有在 2 小时活跃窗口内才进入任务小窗；日报可以带上当天已经摘要过的旧任务。

## 验证

`npm test`、`npm run check`、`npm run test:desktop`；新增 `tests/workbench.test.mjs`、`tests/memory.test.mjs`、`tests/runner.test.mjs`、`tests/dispatch.test.mjs`、`tests/summary.test.mjs`。`scripts/smoke-workbench.cjs` 用真实 Electron 验证工作台页面。测试使用合成会话、假子进程和临时数据，不启动真实 Codex/DSH。
