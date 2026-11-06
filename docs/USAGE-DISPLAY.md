# 额度的请求与展示

挂件只显示额度簿给出的结果，口径见 [额度管理](QUOTA.md)。前端分三层：请求、纯展示和视图；主脚本 `assets/whale-widget.js` 只把当前额度接到气泡上。

## 模块职责

| 文件 | 职责 |
| --- | --- |
| `desktop/ui/usage-client.js` | 读额度簿、把“设为当前”交回额度簿、读两路完成事件并去重、读写音效设置；第一次运行时迁移旧版在页面里保存的来源选择 |
| `desktop/ui/quota-presentation.js` | 额度的文字与进度条：账户标题、进度条、浮层每一行、消耗速度、暂时没有数据的原因，以及给气泡用的状态 |
| `desktop/ui/quota-view.js` | 挂件下方的进度条（账户名、条形、▾）和 ▾ 展开的全部额度 |
| `desktop/ui/quota-manager.js` | 额度管理窗口：账户、记录、提醒 |
| `desktop/ui/usage-presentation.js` | 气泡里的额度与花费文字：订阅两个窗口的剩余与重置时间、余额与今日消费、每轮花费 |
| `desktop/ui/turn-notice.js` | 完成事件的快照，以及是否提示 |
| `assets/whale-widget.js` | 每 10 秒和每次完成事件后读一次额度簿，把当前额度交给气泡和视图，弹出新的额度提醒 |

请求模块不碰 DOM；展示模块是纯函数，不发请求、不访问存储，金额格式化由调用方传入（`WhaleMoney`，没有汇率时按账户自己的币种）。

## 请求接口

`WhaleUsageClient.create({ fetchImpl, shouldNotify, storage, now?, timeoutMs? })` 返回：

- `quotas({ manual })`：读 `/api/quotas`。同时发起的读取共用一次请求；`manual` 先让后台重新查询所有 API 账户。受 25 秒超时约束，回答无效时报错。
- `select(id, at?)`：设为当前，交给 `/api/quotas/current`。
- `migrateChoice()`：旧版在页面里保存的手动选择（`dshw-display-source` 与 `dshw-display-source-manual-at`）带着原来的时间交给额度簿，只迁一次；旧键保留，回退到旧版仍可用。
- `pollCompletions({ codex, claude })`：读两路完成事件，每条只交给对应的回调一次；并发读取不重复消费，启动前与已读的不再提示。
- `settings()` / `saveSettings(patch)`：读写音效与提醒设置，保存失败时拒绝。

游标键不变：`dshw-last-seq`、`dshw-last-turn-id`、`dshw-last-claude-turn-id`。

## 展示接口

`WhaleQuotaPresentation`：

- `current(snapshot)`：当前额度的账户。
- `title(account)` / `label(account)`：如“Codex 订阅 · Plus”“labkey · Codex API”“DeepSeek · 大肥鱼”；气泡标题如“Codex 订阅额度”“labkey 额度”“DeepSeek 余额”。
- `meters(account, { formatMoney })`：进度条，每条是标签、剩余百分比（0–100）、档位（≥50% 正常、20–50% 偏少、<20% 告急）和条形右边的数值：订阅写剩余百分比，API 账户写剩余的额度或余额。订阅给出每个有效窗口；API 有额度上限时给第一条上限，否则给余额占满格的比例；不限额或没有满格时为空。
- `rows(account, { formatMoney, now })`：浮层里每一行的条形、剩余与重置时间；重置时间说成“14:20”“明天 9:05”“周五 10:00”或“10月12日 0:00”。
- `paceText(account, options)`：今日消费与消耗速度的一句话；`today: false` 时不提今日（记录页另有今日金额）。
- `status(account)`：暂时没有数据的原因或查询错误。
- `overview(snapshot)`：浮层列出的账户——有数据的、有问题的，以及当前的。
- `bubbleState(account)`：给气泡用的旧状态字段（订阅窗口、余额、今日消费、币种）。

`WhaleUsagePresentation`：

- `quotaStats(subscription)`：点击气泡里左右并排的窗口，每个是名称（“5小时剩余”）、剩余（“75%”或“已重置”）和档位；订阅没有报告的窗口不列。
- `quotaResets(subscription)`：还在计时的窗口何时重置，如“5小时 14:20 重置”“7天 10/1 20:00 重置”。
- `balanceBubble(value, { formatMoney })`：API 账户的余额与今日消费；加载中与查询失败各有说法，不当成零。
- `taskBubble(notice, formatMoney)`：一轮任务结束时的气泡：订阅上的任务给出标题（完成、未成功或已暂停），API 上的任务给出花费、token 与金额的可信程度。

## 视图

进度条放在主题的底板上，第一行是当前额度的账户名和 ▾，下面是条形。宽度与角色可见部分的底边一致，紧贴在底边下方，跟随拖动、翻转和缩放；角色贴近屏幕底边时改到底边上方。底边由点击检测用的透明度蒙版量出（`desktop/ui/pet-geometry.js`）。点 ▾ 打开全部额度，放在角色旁边放得下的位置；点外面或按 Esc 收起。

页面内事件：

| 事件 | 方向 | 作用 |
| --- | --- | --- |
| `whale-quotas` | 主脚本 → 视图 | 每次读到额度簿的快照 |
| `whale-quotas-request` | 视图 → 主脚本 | 视图启动晚于第一次读取时，要最近的快照 |
| `whale-quotas-changed` | 视图、额度管理 → 主脚本 | 设为当前或账户改动后立即重读 |
| `whale-pet-layout` | 主脚本 → 视图 | 角色移动、翻转、缩放或换图后重新摆放 |
| `whale-open-settings` | 菜单、托盘、浮层 → 额度管理 | 打开额度管理，`detail.tab` 指定页面 |
| `whale-notice-settings`、`-request`、`-state` | 额度管理 ↔ 主脚本 | 完成提示的开关、停留秒数与失败 / 取消提示 |

## 验证

`npm test`、`npm run check`、`npm run test:desktop`。桌面测试在独立临时目录里用合成数据，覆盖进度条的账户名与位置、▾ 浮层与“设为当前”、额度管理的三页、额度提醒气泡，以及会话通过额度管理添加的账户发消息。结果与截图保存在被忽略的 `qa-output/`。

## 订阅气泡

点击气泡不再有自定义模板：订阅账户两个窗口左右并排，标题是账户（如“Codex 订阅额度”），下面是重置时间；订阅上的任务结束时，同样的布局换成“Codex 任务完成”“Claude 回复完成”等标题。2026-09-26 复核里会溢出的两种情况（默认模板的大字号余额行、强制旧余额样式）都来自已删除的自定义泡泡。桌面测试实际点击角色并测量文字边界，确认点击气泡与订阅完成提醒都在内容区内。
