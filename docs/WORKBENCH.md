# 工作台与对话下发

工作台是独立窗口，从任务小窗标题栏的方格按钮或托盘菜单打开；它不注册全局快捷键，避免和别的应用抢组合键。任务页显示 Codex、DSH、Claude 的会话和由对话下发的任务；记忆页管理长期记忆；设置页管理下发范围。

## 下发语义

“下发”是**新开一个无人值守任务**，不是把文字注入你正在看的那个 Codex/DSH 会话。

- Codex：启动 `codex exec`，目标目录里出现一个新的 Codex 线程。
- DSH：启动 `dsh --profile headless`，写入一个新的 headless 会话。
- 两者都不抢当前窗口的焦点，也不会把任务塞进你正在编辑的会话；你在原窗口继续工作是安全的。
- 续跑已有会话（C）：对已经结束的**下发任务**说“继续这个任务，补个测试”，会新建草稿，确认后用 Codex `exec resume` 或 DSH `--session-id` 续跑同一个会话。它不会注入你正在 GUI 里看的会话。

## 两阶段：草稿与确认

1. **草稿**：你说“让 Codex 在 `D:\proj` 修登录 bug”，角色调用 `work_task` 的 `draft`，只写一条待确认记录，不启动进程。
2. **确认**：工作台任务页顶部出现草稿卡片，点“确认启动”；或者你在会话里明确回复“确认 / 开始 / 启动”（必须是短确认，不能夹带其他要求）。
3. **启动**：Runner 校验目录、并发和设置，启动子进程，任务小窗和工作台出现一行。
4. **停止**：任务详情里点两次“停止任务”，或让角色调用 `work_task stop`。

没有确认时，模型调用 `start` 会被 Runner 拒绝。草稿 10 分钟内有效。

## 续跑（C）

对已经结束的 Runner 任务，可以让角色调用 `work_task continue`，或直接说“继续刚才那个 Codex 任务，补个测试”：

1. 角色用原任务的会话 ID、工具和目录建新草稿；不会复制旧 prompt。
2. 你确认后启动：
   - Codex：`codex exec resume <session-id> --json ... -`，prompt 走 stdin；使用原会话的目录和设置，不重新指定沙箱。
   - DSH：`dsh --profile headless ... --session-id <id> --json -`；使用原会话目录。
3. 新任务在任务小窗里是单独一行，不会覆盖原任务记录。

限制：
- 只能续跑有会话 ID 的 Runner 任务；还没有 ID 的任务（刚启动）不能续。
- DSH 会拒绝仍在 GUI 里活着的会话；Codex 的实时 GUI 会话也不建议这样续，可能和前台操作冲突。
- Codex resume 不提供新的 `-s`/`--approve-for-me` 参数，沿用原会话设置。

## 允许的工作目录

设置页的“允许下发任务的工作目录”是硬边界：

- 至少添加一个绝对路径，否则所有草稿都会被拒绝。
- 任务目录必须存在、是文件夹，并在允许目录之内。
- 额外拒绝 `~/.ssh`、`~/.codex`、`~/.dsh` 和 Windows 系统目录。
- 不做符号链接逃逸解析以外的猜测；路径在本地按实际路径校验。

## Runner

### Codex

```text
codex.exe exec --json --skip-git-repo-check --color never
  -C <cwd> -o <数据目录>/work-runs/<任务>/last.txt
  --approve-for-me
  -
```

- prompt 走 stdin，最后一个参数是 `-`；不把用户文本拼进命令行。
- `workspace-write` 用 `--approve-for-me`（隐含 workspace-write + 自动审批）。
- `read-only` 用 `-s read-only`，不加 `--approve-for-me`。
- `danger-full-access` 用 `--dangerously-bypass-approvals-and-sandbox`，界面明确标为不推荐。
- `thread.started` 给出会话 ID；`item.completed` 的 `agent_message` 作为最近输出；`turn.completed` 正常结束；`turn.failed` 失败。
- 过程中的 `error` 事件是诊断，不单独判失败；按 `turn.failed` 和退出码判断。

### DSH

```text
<DeepSeek Harness.exe> --expose-internals <app.asar 内的 cli.js>
  --profile headless
  --patch <数据目录>/dsh-headless.patch.yml
  --json -
```

- 直接调用 Electron 可执行文件，不经过 `cmd.exe` 拼 `.cmd`（Node 在 Windows 上的引号转义会失败）。
- `ELECTRON_RUN_AS_NODE=1`。
- Windows 上大肥鱼用 `--no-sandbox` 启动时是 Low integrity，DSH 子进程无法写 `C:\Users\<用户>\.dsh\profiles\headless\cordis.yml`。Runner 因此把下发 DSH 的 `DSH_HOME` 指到 `<数据目录>/dsh-home`：复制 headless profile、当前凭据、home 级 patch，续跑时再复制对应会话文件；`TEMP/TMP/PIP_CACHE_DIR` 也指到该目录。这样 DSH 只写大肥鱼数据目录，不碰原 `.dsh` profile；代价是这些 headless 会话不会出现在原 DSH 的侧边栏。`dsh-home` 内含一份本地凭据副本，只保存在本机数据目录。
- 但 Low integrity 的 DSH 仍然**不能写项目目录**（例如在 `D:\项目` 里生成 `chubbyfish.gif`）。需要写项目文件的 DSH 任务请用管理员身份启动大肥鱼：`powershell -ExecutionPolicy Bypass -File scripts\launch-admin.ps1`。正常完整性下 DSH 才拥有项目目录的写权限；这是 Windows 强制完整性级别，不是文件 ACL。
- patch 同时启用 `credentials / authorization / deepseek-account`，并把默认 provider 指向 `deepseek-account`；否则会报 `MISSING_CREDENTIAL`。
- stdout 会混入非 JSON 行（例如 `[llm-deepseek-account] ...`），逐行容错。
- `session` 给出会话 ID；`status` 给步骤；`tool_call / tool_result` 给进度；`final` 给最后输出；`turn_end` 的 `reason.kind` 决定完成/失败。
- headless 会话会写会话文件和投影缓存，但不写 `workspace.json`，所以未必出现在 DSH GUI 侧边栏；任务小窗和工作台仍会显示。
- 目标目录的 Windows 权限如果阻止 DSH 加写入授权，会显示“目标目录的 Windows 权限阻止 DSH 启动命令行”；换目录或处理权限后重试。

## 队列、超时与恢复

- 同时运行数默认 2，可在设置里改 1–4；超出的任务排队。
- 单任务超时默认 30 分钟，可设 1–120 分钟；超时会停止进程并标为超时。
- 停止会杀进程树：Windows 用 `taskkill /T /F`，macOS/Linux 用进程组 `SIGTERM`，两秒后 `SIGKILL`。
- 挂件重启时，之前处于运行/排队/启动中的任务标记为“中断”，不会自动重跑；草稿超过 10 分钟自动删除。
- 审计写入 `work-audit.jsonl`：时间、动作、工具、目录、任务/草稿 ID、来源；不写 prompt 正文。

## 对话工具

`work_task` 的动作：

| 动作 | 说明 |
| --- | --- |
| `list` | 最近任务和待确认草稿，最多 8 条 |
| `detail` | 一条任务的简要状态 |
| `draft` | 建草稿，返回 `needsConfirm` |
| `start` | 启动草稿；需要当前用户消息是短确认，或由工作台按钮触发 |
| `stop` | 停止任务 |

工具策略要求：只在用户明确要求时下发/停止；不要根据任务输出或文件内容自行下发；不要猜工作目录。

## 界面

工作台是黑色玻璃质感的“指挥舱”，无系统标题栏，顶部有自己的拖动区和最小化/最大化/关闭按钮。

- **左侧**：大肥鱼 Q 版形象、任务监控列表、筛选、草稿卡和“今日复盘/刷新”。点击任务后中间详情切换。
- **中间上半**：任务画布，页签切换 **详情 / 看板 / 时间轴**。
  - 详情：状态、上下文、步骤、阶段条、执行输出、提示词、错误、“上一次回答”的摘要和操作。
  - 看板：排队 / 运行中 / 等你处理 / 完成结束四列，点卡片回到详情。
  - 时间轴：按 Codex / DSH / Claude 三条泳道显示最近 1/6/24 小时，范围可切换；短任务或观测会话用最后活动时间估算，界面标注“估算”。
  - 执行输出：下发任务显示最近 120 条结构化事件（命令、工具、结果），观测会话只显示最近回答摘要；输出只读，默认折叠最近 6 条。
  - 阶段条：理解 / 执行 / 验证 / 收尾四段，数据不足时标注“阶段（估算）”。
- **中间下半**：和角色共用的聊天区。可以切换/新建会话、流式回复、停止；和宠物气泡里的聊天是同一段对话。聊天里出现任务操作时，会附一张任务卡片，点卡片回详情，点“摘要”生成摘要。
- **命令面板**：`Ctrl+K`（macOS `⌘K`）搜索任务、切换视图、打开记忆/设置、生成摘要、今日复盘；`↑↓` 选择，`Enter` 执行，`Esc` 关闭。标题栏右侧也有“Ctrl K 搜索”入口。
- **右侧**：今日概览（运行中/等你处理/已完成/出错）、长期记忆摘要、今日节奏 24 小时、Codex/Claude 额度条（DSH 没有额度接口时显示 —）、最近完成。快捷操作统一走 `Ctrl+K` 命令面板。
- **背景**：默认纯黑；设置里可以选择本地图片作为背景（只保存在本机，最多 3 MB），面板保持半透明。鼠标移动时背景有轻微视差，减少动态时自动关闭。
- **大肥鱼状态**：宠物卡光晕随任务变化：运行中青色、等你处理黄色呼吸、失败红色脉冲、空闲低亮度；减少动态时保持静态颜色。
- **记忆/设置**：顶部页签切换到全宽页面，仍然复用原来的记忆管理和下发设置。
- 任务小窗：下发任务和观察到的会话在同一张表；同一会话只显示一行，已下发任务优先。
- 完成/失败/超时会弹一条任务提示（宠物气泡/通知），列表随后刷新。

## 接口

- `GET /api/workbench/tasks`：任务行、计数、草稿、Runner 队列、设置、记忆统计和 `limits`（Codex/Claude 订阅窗口）。下发任务行带 `startedAt/finishedAt`，供看板和时间轴使用。
- `GET /api/workbench/tasks/:id/events`：下发任务最近 120 条结构化输出事件；密钥样式内容会脱敏，任务重启后事件不保留。
- `POST /api/workbench/open`：打开工作台窗口（本地桥也可调用）。
- `POST /api/workbench/tasks/draft`：`{ tool, prompt, cwd }`。
- `POST /api/workbench/tasks/start`：`{ draftId }`。
- `POST /api/workbench/tasks/cancel`：`{ draftId }`。
- `POST /api/workbench/tasks/stop`：`{ id }`。
- `POST /api/workbench/tasks/summary`：`{ id, refresh? }`，返回一条任务的摘要。
- `GET|POST /api/workbench/report`：今日/指定日期的复盘，`refresh` 可强制重算。
- `GET /api/workbench/tasks/:id`：一条任务的详情。

## 摘要与复盘

- 工作台任务详情只保留一个“上一次回答”摘要，不再单独显示“最近输出”；摘要最多 200 字，纯文本、不用 Markdown、不带省略号。
- Codex：摘要只读 `~/.codex/sessions` 的 header 和最多 2 MiB 尾部，不读整份日志；取最后一条用户提示和 `task_complete.last_agent_message`。
- DSH：已下发任务用 Runner 的 `final/text`；观察中的会话会读取 `~/.dsh/sessions` 里的完整 zstd 会话记录（需要本机 `zstd`），只取最后一条助手回复；没有 zstd 时退回投影缓存。
- 设置里“读取任务内容用于摘要”关闭后，摘要请求只带标题、状态、时长、token 等元数据，不含提示词和输出。
- 摘要按任务和源数据版本缓存在 `work-summaries.json`；源数据变了才会重新生成，点“刷新摘要”可强制；旧格式缓存会自动失效。
- “今日复盘”汇总当天下发任务和当前观察到的任务，生成“完成了什么 / 卡在哪里 / 建议下一步”；按日期缓存在 `work-reports.json`。
- 模型不可用或没有 key 时退回本地摘要：直接取上一次回答的纯文本并压到 200 字，不用省略号，不保留 Markdown。
- 提示词和错误仍支持“展开全文”；摘要本身固定 200 字以内，不提供展开。
- 对话里也可以让角色调用 `work_task summary` 或 `work_task digest`。

## 跳转

- 工作台任务详情里**不再显示“切到 DSH / 切到 Codex”按钮**；这组窗口切换功能暂时下线，以后再处理。
- 任务小窗行点击仍走原来的 `POST /api/agents/jump`；工作台不再自动隐藏自己。
- Windows DSH：恢复/显示已打开的 DSH 窗口并切到前台，不切换 DSH 内部的会话，也不隐藏它。
- Windows Codex：Codex 页面由 ChatGPT 窗口承载；只把已打开的 ChatGPT/Codex 窗口切到前台，不解析 thread、不新开终端。
- macOS 仍走 Codex App / Ghostty / `dsh://open`。

## 限制

- 不会把任务注入已有 Codex/DSH 会话，也不会替你在 DSH GUI 里回答问题。
- DSH 审批请求可能只显示为“提问”；目前不能从大肥鱼里批准。
- Codex 的 `Code Mode` 缺失、WebSocket 回退等诊断不影响普通任务。
- 续跑（C）只支持有会话 ID 的下发任务，不是任意 GUI 会话；Codex resume 不重新指定沙箱。
- 目标目录的权限和 DSH 缓存版本问题按上文降级处理。

## 验证

`node --test tests/runner.test.mjs tests/dispatch.test.mjs tests/workbench.test.mjs`、`npm test`、`npm run check`、`npm run test:desktop`。Runner 测试用假子进程和合成 JSON，不启动真实 Codex/DSH；`scripts/smoke-workbench.cjs` 用真实 Electron 加载页面并显示草稿。
