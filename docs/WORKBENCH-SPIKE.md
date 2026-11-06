# 工作台 Phase 0 技术验证

2026-10-31。验证“大肥鱼通过对话下发 Codex / DSH 任务，并监控与总结它们”这条链路是否成立。只做验证，不改产品代码。

## 环境

- Windows 11，当前用户普通权限。
- DSH `0.2.1-rc.3`，安装于 `%LOCALAPPDATA%\Programs\DeepSeek Harness`。
- Codex CLI `0.162.0-alpha.17.2`，本机路径 `%USERPROFILE%\.codex\.sandbox-bin\codex.exe`。
- 临时验证目录：`.tmp-plan/spike/`（不提交）。

## 结论

**GO。** 两套下发链路都能工作，但 DSH 有两个必须处理的额外条件，已找到可用做法：

1. **DSH 的 headless profile 默认用 `deepseek-official` API Key 路由，不会自动复用 GUI 的登录账户。** 只在 `--patch` 里打开 `credentials / authorization / deepseek-account` 还不够，必须同时覆盖 `agent-default-model`，把 provider 指向 `deepseek-account`。否则报 `MISSING_CREDENTIAL`。
2. **DSH 的 headless 会话会写会话文件和投影缓存，但不会写 `workspace.json`。** 因此 DSH GUI 的侧边栏很可能看不到这些下发任务；工作台必须自己保存任务记录并作为任务视图，不能只依赖 GUI 列表。

另外确认：Codex 下发任务会进入现有 `~/.codex/sessions` 监视链路；DSH 观测会话的投影缓存足够推导状态、标题、token、步骤；DSH 的 `--session-id` 可以续跑已结束的 headless 会话。

## 验证项与结果

| 验证项 | 结果 |
| --- | --- |
| Codex 非交互执行 | 通过 |
| Codex 会话进入现有监视解析 | 通过 |
| Codex 日志尾部摘要 | 通过 |
| DSH headless 非交互执行 | 通过（需 patch） |
| DSH headless 凭据复用 | 通过（需覆盖 provider） |
| DSH headless 续跑 | 通过 |
| DSH 观测会话状态解析 | 通过 |
| DSH 下发会话进入投影缓存 | 通过（完成后写入） |
| DSH 下发会话进入 GUI 侧边栏 | **未通过/未验证**，`workspace.json` 未收录 |
| DSH 工具调用进度事件 | 通过 |

## 1. Codex

### 1.1 可用命令

```text
codex.exe exec --json --skip-git-repo-check --color never
  -C <cwd>
  --approve-for-me
  -o <last-message-file>
  -
```

- prompt 通过 stdin 传入，最后一个参数 `-` 表示从 stdin 读；这避免把用户文本拼进命令行。
- `--approve-for-me` 隐含 workspace-write 沙箱与自动审批。
- **`--approve-for-me` 不能和 `-s/--sandbox` 同时使用**，会直接报参数冲突。要只读沙箱时用 `-s read-only` 且不加 `--approve-for-me`。
- `-o` 会把最后一条回复单独写到文件，便于摘要；stdout 仍是 JSONL 事件流。

实测输出（节选）：

```json
{"type":"thread.started","thread_id":"01a19095-..."}
{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}
{"type":"turn.completed","usage":{"input_tokens":16812,"cached_input_tokens":13312,"output_tokens":5}}
```

退出码 0，`-o` 文件内容为 `OK`。

### 1.2 事件映射注意

- `thread.started.thread_id` 就是 Codex 会话 ID，可与 `~/.codex/sessions` 文件名中的 ID 对应。
- `item.completed.item.type` 可能是 `agent_message`、`command_execution`、`image_view`、`extension`、`reasoning` 等；摘要只取 `agent_message` 和工具名。
- 过程中可能出现 `error` 事件，但不代表任务失败：
  - `Code Mode is unavailable ...`：本机缺 `codex-code-mode-host.exe`，Code Mode 关闭，不影响普通任务。
  - `Reconnecting...` / `Falling back from WebSockets to HTTPS`：传输回退，最终仍可能 `turn.completed`。
- **失败判定**：`turn.failed` 或进程退出码非 0；不要因为出现 `error` 事件就判失败。
- `codex exec` 的会话 `originator` 是 `codex_exec`，现有 `SessionParser` 能正常解析为 `running → done`，`app:false`。

### 1.3 现有监视链路可直接复用

对验证任务跑现有 `SessionParser`，得到：

```text
start -> running (cwd=...codex-work) -> running (tokens=19579) -> done -> end completed
```

说明下发的 Codex 任务会自动出现在任务小窗/工作台，不需要另写监视器。

### 1.4 日志尾部摘要

Codex 日志是明文 JSONL，摘要读取方式：

1. 读文件头第一行拿 `session_meta`（会话 ID、cwd、originator、thread_source）。
2. 读文件尾部最多 2 MiB，按行解析：
   - 最后一条非环境注入的 `response_item/message`（role=user）作为提示词。
   - 最后一条 `event_msg/task_complete.last_agent_message` 作为结果。
   - `task_complete` / `turn_aborted` 作为结果状态。
3. `session_index.jsonl` 的 `thread_name` 可作标题；`codex_exec` 会话通常没有，回退到提示词/项目名。
4. 过滤 `thread_source === 'subagent'`、`source.subagent`、以及 `Guardian review` 一类审批子会话，不纳入任务列表/摘要。

注意：大文件（10–30 MiB）的尾部 2 MiB 可能不包含最后一条 user 消息；标题可用 `session_index`，摘要用 `last_agent_message` 即可，提示词缺失不阻塞。

## 2. DSH headless

### 2.1 可用命令

不要用 `cmd.exe` 拼 `.cmd` 路径。Node 的 `spawn` 对 Windows 引号转义会变成 `\"C:\...\"`，`cmd` 找不到命令。推荐直接调用安装目录里的 Electron 可执行文件（`dsh.cmd` 内部就是这么做的）：

```text
<安装目录>\DeepSeek Harness.exe --expose-internals
  <安装目录>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js
  --profile headless
  --patch <大肥鱼数据目录>\dsh-headless.patch.yml
  --json
  -
```

环境变量：

```text
ELECTRON_RUN_AS_NODE=1
```

- prompt 通过 stdin 传入，`-` 表示从 stdin 读。
- 工作目录即目标项目目录，DSH 会把它记为会话 cwd。
- `cli.js` 在 `app.asar` 内，普通 Node 的 `fs.existsSync` 看不到它，但 Electron 能加载；不要用 `existsSync` 判断。
- 也可以用 PATH 上的 `dsh`，但 Windows 下同样要避免 `.cmd` 引号问题；直接 Electron 调用最稳。

实测输出（节选）：

```json
{"type":"session","sessionId":"session-fab3f317-...","cwd":"D:\\..."}
{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"thinking","text":""}
{"type":"text","text":"OK"}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"OK"}
```

退出码 0。`--json` 事件类型：`session / status / thinking / text / tool_call / tool_result / final / error`。

### 2.2 凭据 patch（关键）

只打开三个凭据行不够。headless 默认模型 provider 是 `deepseek-official`，它要 `DEEPSEEK_API_KEY`；GUI 登录的是 `deepseek-account`。必须同时覆盖 `agent-default-model`：

```yaml
- id: agent-default-model
  config:
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: high
- id: credentials
  disabled: false
- id: authorization
  disabled: false
- id: deepseek-account
  disabled: false
```

用 `dsh --profile headless --patch <file> --dump-config` 确认过：三个凭据行均为 `disabled: false`。

- 只加凭据行、不改 provider：`MISSING_CREDENTIAL: no API key for provider route "deepseek-official"`。
- 加 provider 覆盖后：正常返回 `final: "OK"`。
- 这个 patch 只影响 headless 子进程，不修改 `~/.dsh/profiles/headless/cordis.patch.yml`；每次下发用 `--patch` 传。
- `model` / `reasoningEffort` 建议从 `~/.dsh/profiles/desktop/cordis.patch.yml` 读取（当前为 `deepseek-flash` / `high`）；第一版可先用固定默认，设置里允许改。

### 2.3 非 JSON 输出

stdout 会混入非 JSON 行，例如：

```text
[llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)
```

解析必须逐行 `try/catch`，忽略非 JSON，不能把整段 stdout 当 JSON 数组。

### 2.4 续跑

对已结束的 headless 会话执行：

```text
... --session-id session-fab3f317-... --json -
```

返回同一 `sessionId`，`turn: 2`，`final: "OK2"`，退出码 0。说明 C（续跑历史会话）可行。

注意：
- 如果会话仍在 GUI 中活着，DSH 会拒绝 adoption（设计如此）；大肥鱼只能续跑自己下发且已结束的 headless 会话。
- 续跑要求 cwd 与记录一致，且 agent preset 一致。

### 2.5 下发会话的可见性

- 会话文件：`~/.dsh/sessions/<编码后的 cwd>/<session-id>/session.v4.jsonl.zstd`，会写入。
- 投影缓存：`~/.dsh/storages/session_projcache/sessions/<session-id>.json`，会写入。
- `~/.dsh/storages/workspace.json`：**未写入**。本次验证的三个 headless 会话都不在其中。
- 结论：DSH GUI 侧边栏很可能不显示这些会话。工作台必须自己保存 `work-tasks.json`，以 Runner 事件 + 投影缓存为准；不要依赖 GUI 列表。
- headless 会话的投影缓存**在任务完成后才写入**（实测 12 秒任务在完成时一次性出现）。运行中的进度只能来自 Runner 的实时 JSON 事件；完成后用缓存补全标题/token/结果。

### 2.6 目标目录的 Windows 权限风险

在 `.tmp-plan/spike/dsh-work` 这类目录里，DSH 的 workspace-write 沙箱可能无法给目录加写入授权，工具调用报：

```text
SetNamedSecurityInfoW failed (Win32 5): grantWrite(<cwd>)
```

此时文件读取工具仍可用，但 `pwsh` 等命令工具全部启动失败。项目根目录 `D:\工作文件\6.DSH\1.bigfatfish` 下同样的任务正常。

处理：
- 不要把这类错误当成“模型失败”；在任务详情里显示“目标目录的 Windows 权限阻止 DSH 启动命令行”，建议换目录或运行权限诊断。
- 可在 Runner 中识别 `SetNamedSecurityInfoW` / `grantWrite(` 并给出明确提示，不自动改权限。

## 3. 监控与摘要

### 3.1 DSH 投影缓存

路径：`%USERPROFILE%\.dsh\storages\session_projcache\sessions\session-*.json`，当前 `version: 7`。

可用字段：

| 用途 | 字段 |
| --- | --- |
| 会话 ID / cwd | `record.identity`、`rows.workingDirectory.val` |
| 标题 | `rows.title.val` |
| 最近提示词/回复 | `rows.turnOutline.val.turns[]` |
| 当前步骤 | `rows.sessionStats.val.openStep` / `steps` |
| 运行中 | `rows.turnBoundary.val.openTurnStartSeq != null` 或 `sessionStats.openStep` |
| 提问 | `rows.userQuestions.val.questions.active` |
| 失败 | `rows.goal.val.failure`、`rows.llmRetry.val` |
| token / 上下文 | `rows.contextPressure.val.surfaceTokens` / `contextWindow` |
| 完成边界 | `rows.turnBoundary.val.lastStepBoundary.kind === 'end'` |
| 最近活动 | 文件 mtime、`rows.timeContext.val.lastMessageTime` |
| 归档 | `workspace.json.global.archivedSessionIds` |
| 项目名 | `workspace.json.tables.workspaces[].title`，回退 cwd basename |

状态映射验证（当前会话）：

```text
running  step 31  18.8% 1.bigfatfish  基于大肥鱼的工作助手Agent计划  | open step
```

历史会话正确显示 `idle`、`done`。

注意：
- headless 会话的缓存没有 `sessionStats` 行；用 `turnBoundary` 和 Runner 事件补状态/步骤。
- `sessionStats.openStep` 可能为 `null` 而 `pendingCalls` 非空（工具正在跑）；运行判定要把 `pendingCalls` 也算上。
- 缓存是内部格式，版本变化时降级为“DSH 任务暂不可读”，不能影响 Codex。

### 3.2 Codex 摘要

见 1.4。实测可提取：

```text
session 01a19004-...
cwd ...\codex-work
prompt 只回复 OK，不要使用任何工具。
lastAgent OK
outcome completed
```

## 4. 对正式实现的影响

1. **Codex Runner 参数固定为**：`exec --json --skip-git-repo-check --color never -C <cwd> --approve-for-me -o <last> -`，prompt 走 stdin；失败判定看 `turn.failed` / 退出码，忽略诊断性 `error`。
2. **DSH Runner 用直接 Electron 调用**，不用 `cmd.exe` 拼 `.cmd`；带 `ELECTRON_RUN_AS_NODE=1`，prompt 走 stdin；解析逐行 JSON，忽略非 JSON。
3. **DSH patch 必须同时包含 `agent-default-model` 的 `deepseek-account` 覆盖和三个凭据行**；放在大肥鱼数据目录，随 Runner 传入，不改用户 profile。
4. **DSH 下发任务不依赖 GUI 列表**；工作台保存自己的任务记录，运行中用 Runner 事件，完成后用投影缓存补全。
5. **DSH 目标目录权限错误要单独提示**，不要误判为模型失败。
6. **摘要/任务列表过滤 Codex 子代理**（`Guardian review` 等），只显示用户任务。
7. **事件存储要截断**：DSH `tool_result` 可能包含整段 skill 文档；每个任务只保留最近 200 条、每条 ≤ 500 字符，避免内存和磁盘膨胀。

## 5. 是否继续

GO。没有阻塞性发现。建议按以下顺序进入实现：

1. Phase 1：统一任务模型 + DSH 投影缓存读取 + 任务小窗 DSH 行。
2. Phase 2：长期记忆。
3. Phase 3：Codex / DSH Runner + 草稿确认。
4. Phase 4：摘要与日报。
5. Phase 5：独立工作台窗口 + 文档/测试。

仍待产品确认/后续验证：
- DSH GUI 是否真的不显示 headless 会话（需要一次人工打开 DSH 侧边栏确认）。
- DSH 审批请求是否进入投影缓存（当前只验证了 `userQuestions`）。
- DSH 版本升级后投影缓存 `version` 是否变化。
- Codex `Code Mode` 缺失是否影响某些任务（当前只影响 Code Mode 功能）。

## 6. Phase 1 已落地（2026-10-31）

按本结论实现了只读任务总线：`runtime/agents/dsh.mjs` 读取 `session_projcache`，`AgentBoard` 把 DSH 行并入 `/api/agents`；任务小窗增加 DSH 图标和“工作台”入口；独立工作台窗口（`desktop/workbench-window.cjs`、`desktop/ui/workbench.*`）通过 `/api/workbench/tasks` 和 `/api/workbench/settings` 显示任务、摘要占位与设置。`tests/workbench.test.mjs` 覆盖状态映射、归档过滤、窗口位置记忆和路由；`scripts/smoke-workbench.cjs` 用真实 Electron 渲染工作台页面。DSH 审批、headless 会话进入 GUI 列表、以及真实下发仍留到后续阶段。

Phase 2 也已落地：`runtime/workbench/memory.mjs`、`memory-prompt.mjs` 和 `tools.mjs` 提供 4 KB / 40 条的长期记忆、`memory_list / memory_save / memory_forget`、空闲整理和从历史初始化；工作台“记忆”页支持查看、编辑、重要、忘掉、立即整理和从历史初始化。详见 [长期记忆](MEMORY.md)。

Phase 3 已落地：`runtime/workbench/runner.mjs` 用固定参数启动 `codex exec` / `dsh headless`，支持草稿、确认、并发队列、停止、超时、重启中断恢复和审计；`task-tools.mjs` 提供 `work_task` 对话工具；工作台任务页显示草稿并支持启动/放弃/停止。详见 [工作台与对话下发](WORKBENCH.md)。

Phase 4 已落地：`codex-digest.mjs` 读 Codex 日志头尾，`summary.mjs` 生成任务摘要/日报并缓存到 `work-summaries.json`、`work-reports.json`；`work_task` 增加 `summary`/`digest`；工作台详情有“生成摘要”，工具栏有“今日复盘”，内容读取开关已接入。
