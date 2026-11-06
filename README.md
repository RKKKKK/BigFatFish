# 大肥鱼 BigFatFish

一只常驻桌面的宠物，帮你盯着同时在用的几个 AI 编程工具：Codex 和 Claude Code 的订阅额度、API 余额，以及每个会话现在在做什么；它自己也能以角色人设陪你聊天、管番茄钟。支持 macOS，Windows 适配进行中。

## 基于谁开发

本仓库从 **MeteorNOX** 的 [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) 的 **For-Codex** 分支 0.2.4（提交 `8de181a`）分出，之后独立开发。

- 上游主线是 DeepSeek Harness 网页里的余额挂件（`dsh-whale-widget`）；For-Codex 分支把它改造成 Codex 的桌面伴随挂件（“API 余额小鲸鱼”）。角色立绘、气泡和音效素材都来自上游。
- 0.2.4 之前的贡献者：**[@MeteorNOX](https://github.com/MeteorNOX)**（上游项目与全部基础工作）、**[@1llysviel](https://github.com/1llysviel)**（macOS 适配，[PR #128](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/128)）、**Oven**、**[@Yang-huai406](https://github.com/Yang-huai406)**；历史名单见 [`docs/CHANGELOG-0.2.4.md`](docs/CHANGELOG-0.2.4.md)。
- 上游的 Codex 版后来在 [Yang-huai406/Codex-Whale-Public](https://github.com/Yang-huai406/Codex-Whale-Public) 继续发展；本仓库从 0.2.4 起各走各的，两者互不通用。
- 代码沿用上游的 MIT 许可与署名（见 [`LICENSE`](LICENSE)）；`assets/` 里的图片和音效不在 MIT 范围内，随项目原样分发。改造范围与许可边界见 [PROVENANCE.md](PROVENANCE.md) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，上游原版说明备份在 [docs/UPSTREAM-README.md](docs/UPSTREAM-README.md)。

## 在 0.2.4 之上新增了什么

- **独立桌面宠物**：不再跟着 Codex 窗口走，登录后自动出现，Codex 关了也在；能拖到屏幕最顶端，气泡改到头旁边（[ADR 0001](docs/adr/0001-retire-codex-window-follow-mode.md)）。
- **额度管理**：一个额度簿统一管 Codex 订阅、Claude 订阅、Codex 用的 API 账户（如中转站）和大肥鱼自己的账户。角色下方的进度条显示正在用的账户、还剩多少，▾ 展开全部；有消耗速度预测、“安全额度”、消费记录和额度提醒，金额可统一换算成美元或人民币（[额度管理](docs/QUOTA.md)）。
- **Claude Code 接入**：通过 Claude Code 官方状态栏读取 Pro/Max 的 5 小时、7 天额度，回复完成时提醒（[Claude 订阅额度接入](docs/CLAUDE-USAGE.md)）。
- **角色会话**：右键和大肥鱼聊天，多会话、流式回复、DeepSeek 计费与余额，macOS 上 Ctrl+0 随时呼出（[角色会话](docs/CHAT.md)）。
- **主动闲聊与番茄钟**：在你设定的时段偶尔主动搭话；说一句话就能安排专注和休息，到点提醒（[主动闲聊与番茄钟](docs/COMPANION-ACTIVITY.md)）。
- **三套蓝色主题**：海盐汽水、深海夜光、女仆墨蓝，在菜单里切换；点角色的气泡只说额度，去掉了自定义泡泡编辑器。
- **任务小窗**：屏幕上常驻一个小窗，每个 Claude Code、Codex CLI、Codex App、DSH 会话一行：处理中、完成、提问、要权限、卡住、出错、空闲各有颜色，右侧是上下文 token；点一行跳回那个会话（macOS 上是 Ghostty 的标签；DSH 聚焦 DSH 窗口），左右滑走一行，可收起或跟着角色。标题栏的方格按钮打开独立的**工作台**窗口，看任务详情和设置（[任务小窗](docs/AGENTS.md)）。
- **对话下发**：对角色说“让 Codex 在 `D:\proj` 修登录 bug”或“让 DSH 在 `D:\docs` 整理目录”，它会先建草稿；你在工作台点确认、或回一句“确认”后才启动无人值守任务。任务进入任务小窗，可停止、看输出、打开会话；已结束且有会话 ID 的任务可以说“继续”续跑（Codex `exec resume` / DSH `--session-id`）。有共享的并发队列、超时、目录白名单、审计和重启中断保护（[工作台与对话下发](docs/WORKBENCH.md)）。
- **任务摘要与复盘**：工作台任务详情只显示“上一次回答”的摘要（最多 200 字、纯文本、不用 Markdown），也可以点“今日复盘”汇总当天任务。Codex 只读日志头尾，DSH 用输出/投影缓存；设置里关掉“读取任务内容”后只按元数据总结。摘要和日报有本地缓存（[工作台与对话下发](docs/WORKBENCH.md#摘要与复盘)）。
- **长期记忆**：独立工作台里的“记忆”页维护一份最多 4 KB / 40 条的长期事实：称呼、偏好、长期要求、项目背景、已定决定和少量近期事件。角色会话里的 `memory_list / memory_save / memory_forget` 工具可以读写，空闲时自动整理；重启后仍在，不把整段聊天塞进上下文（[长期记忆](docs/MEMORY.md)）。
- **工程**：行为测试和隔离的桌面冒烟测试（不花任何模型额度）、模块拆分、术语表 [CONTEXT.md](CONTEXT.md) 和架构决策记录 [docs/adr](docs/adr)。

## 分支

- **`main`**：macOS 上验证过的版本。
- **`windows-support`**：Windows 适配，按推断写成、还没在 Windows 实机上跑过；验证与调试见分支里的 `docs/WINDOWS-PORT.md`。

## 概览

**没有独立网页、浏览器面板或本地网页端口。** 界面由透明辅助窗口承载，通过本地进程间通信读取数据。所有菜单、设置、素材和账本都在挂件中操作。它并未修改或注入 Codex 的安装文件。

**运行平台**：Windows 10/11 x64，或 Apple Silicon / Intel Mac；需要 Node.js 24+。挂件本身不依赖 Codex 桌面应用运行；安装 Codex 后才能在本机会话记录中观察 Codex token 用量。详细步骤见 [macOS 安装说明](docs/MACOS.md)。

**安全说明**：挂件从本机 Codex 配置、指定环境变量或系统安全存储（macOS Keychain / Windows DPAPI）读取密钥；本地解析配置但不会返回或记录原始 `config.toml` / `auth.json` 内容。密钥只会发送给用户配置的 API provider；挂件还会访问公开汇率接口。角色会话把用户输入、角色人设及会话上下文发送给配置的聊天接口；启用主动闲聊后，也可能在设定时段内发送最近保留的聊天记录。不会发送 Codex 聊天内容或读取用户当前桌面活动。

挂件统一管理四类额度：Codex 订阅、Claude 订阅、Codex 用的 API 账户（例如中转站），以及大肥鱼自己说话用的账户（默认 DeepSeek）。角色下方显示**当前额度**，也就是最近有活动的那个账户，点 ▾ 可以看全部；密钥只在“额度管理”里填写，留在本机，界面不回显。口径与规则见 [额度管理](docs/QUOTA.md)。

## 使用

- 登录后小鲸鱼会独立出现在桌面，无需打开 Codex、发消息或打开网页。
- 角色下方是当前额度的进度条，写着账户名：订阅显示 5h、7d 两条剩余比例；API 账户有额度上限时显示剩余比例，否则以充值后观测到的最高余额为满格。点 **▾** 展开全部额度：每个账户还剩多少、何时重置、今日消费，以及照这个速度够用多久；可以“设为当前”。
- 点击鲸鱼：气泡显示当前额度，订阅账户的 **5 小时剩余 / 7 天剩余** 左右并排、下面是重置时间，API 账户显示余额和今日消费；点气泡关闭；按住拖动：移动位置并记忆，可以一直拖到屏幕顶端，上方放不下气泡时气泡显示在鲸鱼头部旁边；移到边缘：按原设置吸附、翻转。
- 个人 ChatGPT 账户的 Codex 对话完成时，若该轮带有完整订阅快照，自动完成提示也显示 **5 小时剩余** 与 **7 天剩余**，而非“金额未知”和 token；工作 API Key 会话继续显示原有 API 金额／token 提示。
- 鼠标移到鲸鱼上，点击 **☰**：最上方切换 **主题**（海盐汽水、深海夜光、女仆墨蓝，立即生效、重启后保留），下面依次是外观（角色、大小）、声音、气泡与金额、桌面几组设置，以及 **额度管理**（账户、记录、提醒）和 **会话设置**。
- 右键角色：在角色下方打开会话并聚焦输入；Enter 发送，Shift+Enter 换行。菜单中的 **会话设置** 选择大肥鱼账户、模型、人设与最长回复 token 数；账户和密钥在额度管理里添加。回复气泡随流式内容增长，支持停止、记录和新会话。详见 [角色会话](docs/CHAT.md)。Shift+右键仍可打开挂件菜单。
- 角色会话支持 **会话列表、新建、继续旧会话和单独删除**；macOS 按 Ctrl+0 可全局打开并聚焦输入框。旧记录自动迁移，普通会话的上下文各自独立；存放主动闲聊的“随便聊聊”记得所有会话的近况。删除会话保留消费。
- DeepSeek 官方角色会话在发送按钮左侧显示 **本地近 30 天消费估算与账号余额**，支持手动刷新，金额跟随显示币种。消费取估算上下限平均值并保留两位小数，来自本地聊天调用及可恢复的历史用量，独立保存；不代表官网账号总消费。余额与额度管理看到的是同一次查询。
- **主动闲聊与番茄钟**：会话设置可启用主动闲聊并指定时间段和频率；直接对大肥鱼说出专注、休息、循环要求，它可按人设安排或调整时间，到点提醒。点击阶段提醒即可开始休息或下一轮专注，菜单“声音”里的“番茄钟”可独立开关或自定义提醒音。番茄钟操作使用固定白名单，不逐次弹权限窗口；详见 [主动闲聊与番茄钟](docs/COMPANION-ACTIVITY.md)。
- **任务小窗**：屏幕右上角常驻一个小窗，每个 Claude Code、Codex CLI、Codex App、DSH 会话一行：状态点（绿＝处理中／完成，黄＝提问／要权限，红＝卡住／出错）、工具图标、项目、状态和上下文里的 token。点一行跳到那个会话的 Ghostty 标签、Codex 线程或 DSH 窗口，左右滑动一行把它移走；鼠标停在一行上看详情。可以跟着大肥鱼、拖到别处或收起成一列点，菜单“桌面”里可关闭。标题栏的方格按钮打开**工作台**窗口，看完整的任务列表、详情和设置。详见 [任务小窗](docs/AGENTS.md)。
- **对话下发**：先在工作台设置里添加允许的工作目录。对角色说“让 Codex 在 `D:\proj` 修登录 bug”，它会创建草稿；工作台任务页顶部点“确认启动”，或在会话里明确回复“确认”。任务小窗出现一行，工作台看详情、停止或打开。下发的任务不会注入你正在看的会话，也不会抢焦点。详见 [工作台与对话下发](docs/WORKBENCH.md)。
- **摘要与复盘**：工作台任务详情里点“生成摘要”，只显示上一次回答的 200 字以内纯文本摘要，不用 Markdown。“今日复盘”按当天任务给出完成/卡点/下一步。也可以在会话里让角色总结某个任务或今天的工作。详见 [工作台与对话下发](docs/WORKBENCH.md#摘要与复盘)。
- **黑色指挥舱**：工作台改成无系统标题栏的黑色玻璃界面：左侧任务监控和大肥鱼 Q 版形象，中间“详情 / 看板 / 时间轴”任务画布 + 角色聊天，右侧今日概览、长期记忆、今日节奏/额度条和最近完成。`Ctrl+K` 打开命令面板，可搜任务、切视图、生成摘要或打开今日复盘；聊天里的任务结果会附可点击的任务卡片。面板半透明，默认纯黑背景，设置里可选本地背景图。
- **长期记忆**：直接对大肥鱼说“以后回复先给结论”“记住我叫 RK”，它会用 `memory_save` 存下精简事实；说“忘掉……”会用 `memory_forget` 删除。记忆页可以查看、编辑、标记重要、立即整理、从历史初始化或清空；自动整理只在积累几轮且空闲后发生，不会每轮都发一次模型请求。详见 [长期记忆](docs/MEMORY.md)。
- Codex 请求权限时，提醒气泡会一直显示，点击气泡或鲸鱼后关闭；菜单“声音”里的“审批提醒”可单独关闭或选用已导入的音频片段／音效组。
- **Windows：Ctrl+Alt+W；macOS：Cmd+Option+W**，也可使用系统托盘菜单：隐藏/显示。工作台从托盘菜单或任务小窗标题栏的方格按钮打开（不占用全局快捷键，避免和别的应用冲突）。托盘菜单可刷新额度、查看额度记录、查看运行状态或停止当前挂件；macOS 的鲸鱼 `☰` 菜单底部也有这些命令，Windows 上只有查看额度记录。
- 新建 Codex 任务后可说“打开小鲸鱼”“看看我的额度”。更新前已打开的任务可能仍持有旧版工具，需新建任务。

**金额统一显示两位小数**，包括余额、今日/历史用量、每轮费用和气泡。后台仍保留原始精度，小额消费不会因显示取整而丢失。音频裁剪时间和 token 整数计数不属于金额。

**界面与币种修复版**：工具窗口避免透明挂件被误判为遮挡 Codex；恢复原版 300 毫秒翻转，移动与按压分别合成。菜单和额度管理都能切换金额显示：默认按各账户的原币种，也可以统一换算成美元或人民币，余额和记录使用同一份带日期的汇率。显示中的气泡保留金额快照；后台刷新后，下次打开才更新。慢图片准备期间保留旧画面。技术实现见 [渲染实现](docs/RENDERING.md)。

**失败、暂停／取消与汇率**：失败或暂停／取消仍保存可观测消耗，气泡显示中性的扣费提示，不播放成功结束音；关闭对应开关后不再弹出这类气泡。不能确认的金额显示待记账/金额未知，不把后续扣费再分配给本轮。汇率按北京时间每日 **00:15** 检查，菜单提供主动刷新，费率说明在刷新汇率右侧的 **!** 按钮里；15 秒防连点，说明含报价日期、最近成功获取与最近检查时间。周末或节假日报价可能不变，断网保留并标注旧缓存。

**素材与稳定性**：导入校验格式、尺寸和动画预算，坏角色启动时回退到内置鲸鱼；APNG 后续帧可点击。外链只接受用户点击的普通 HTTP/HTTPS 地址；退出有期限，未完成用量通过安全日志保留恢复线索。

**峰谷功能已移除**：无峰谷设置、状态文字、倒计时或时段倍率。升级时移除旧气泡中的峰谷模块，保留其他文本、顺序、样式、图片、音效和账本，并保留迁移前配置副本。

## 安装、停用与回滚

Windows 需要 Node.js 24+；先运行 `安装桌面组件.cmd`，再运行 `安装开机自启.cmd`。macOS 直接双击 `安装 Mac 开机自启.command`，它会优先使用 Homebrew 的 Node/npm，安装 Electron 44.3.0 并注册当前用户的 LaunchAgent。组件安装需联网获取 Electron。详细步骤和卸载入口见 [macOS 安装说明](docs/MACOS.md)。

Windows 使用任务计划服务，macOS 使用用户级 LaunchAgent。桌面服务均以当前用户普通权限运行，登录后启动独立挂件；Codex 的打开、移动、最小化和退出均不会影响其显示。无需管理员权限，不保存登录密码，不调整执行策略或安全软件设置。

早期版本让挂件跟随 Codex 窗口移动，这一模式已经移除（见 [ADR 0001](docs/adr/0001-retire-codex-window-follow-mode.md)）。按旧方式安装的电脑无需重装，下次登录或重新运行安装入口后即以独立桌面方式运行。原来的“安装自动跟随”“停用自动跟随”入口已改名为“安装开机自启”“停用开机自启”。

桌面服务不保留命令窗口；可用“停止挂件服务”与“启动桌面挂件”控制当前实例。计划任务名为 **Codex API Balance Whale**；异常退出会尝试恢复。停用与回滚入口：

- `停用开机自启.cmd`：停止桌面服务与挂件并移除开机启动项，保留设置、素材和账本。
- `停止挂件服务.cmd` / `启动桌面挂件.cmd`：仅停止或启动当前挂件进程。
- 源码回退使用固定 Git 标签；当前版本为 `codex-v0.3.0`（[0.3.0 变更](docs/CHANGELOG-0.3.0.md)），此前的步骤见 [0.2.5 基线与回退](docs/BASELINE-0.2.5.md)。用户数据须单独备份。

macOS 对应入口为 `安装 Mac 开机自启.command`、带鲸鱼图标的 `启动桌面挂件.app`（或兼容入口 `启动桌面挂件.command`）、`停止挂件服务.command`、`停用开机自启.command`；也可运行 `npm run install:mac`、`npm run uninstall:mac`。

发布压缩包不含作者本机的备份与密钥，另一台电脑请在做任何升级前自行备份插件目录。

## 余额与用量口径

完整口径见 [额度管理](docs/QUOTA.md)；下面是各类余额接口的要点。

- 兼容账单接口：余额为 `hard_limit_usd - total_usage / 100`。账单总用量按接口单位换算；换算参数可配置。
- New API/One API：返回密钥额度时明确标注，密钥不限额不会显示为账户无限余额。
- 查询链接：中转站的日用量与额度上限（`daily_usage`、`rate_limits`），链接须与 API 地址同域。
- 其他服务：支持同域 JSON 接口、字段和单位配置（额度管理里账户的“高级”）；账户换网站时必须重新填写那个网站的密钥，不会把旧密钥发往新域名。
- 项目级 `.codex/config.toml` 也不能自动改投全局密钥。余额/汇率响应分别限制为 1 MiB/64 KiB。
- 没有可验证的余额接口时显示不可查询，不虚构官方 OpenAI 余额接口或订阅余额。

订阅额度来自本机 `~/.codex/sessions` 中 Codex 写入的非敏感限额快照：只读取 `codex` 的 300 分钟与 10080 分钟窗口、已用百分比和重置时间，不启动临时 Codex 会话、不执行 `/status` 或 `/delete`，也不保存会话正文、账号信息或认证数据。Codex 一轮跑在订阅上时算作 Codex 订阅的活动，跑在 API 账户上时算作那个账户的活动，挂件显示最近有活动的那个。某个窗口重置后不再显示它的旧百分比，另一个窗口照常显示。

Claude Code Pro/Max 额度通过官方 `statusLine` 接入；官方 hooks 会在 Claude 回复完成时触发挂件提示，并告诉任务小窗每个会话在做什么。Claude 回复完成算作 Claude 订阅的活动；也可以在 ▾ 浮层里把任一账户“设为当前”。Claude 的 5 小时和 7 天额度在状态栏产生新快照后更新。安装、卸载及数据口径见 [Claude 订阅额度接入](docs/CLAUDE-USAGE.md)。

今日/历史金额来自同密钥累计消耗或余额差值观测，不能充当服务商正式的逐请求账单。每轮金额区分“期间扣费”和“按配置价格估算”；并行调用或延迟入账可能影响期间扣费。没有金额及价格时仅记录 token。

日汇总长期保留；旧版已删除的汇总显示未知，无法凭空补回。停机、跨午夜的观测间隔归入再次观测日。查询链接返回每日消费时以它为准。明细最多保留 8000 条，记录页列出最近 100 条。

## 数据与维护

Windows 本机源码通常位于 `%USERPROFILE%\plugins\api-balance-whale`，挂件数据默认位于 `%USERPROFILE%\.codex\whale-widget`。macOS 本机源码通常位于 `~/plugins/api-balance-whale`，挂件数据默认位于 `~/.codex/whale-widget`。设置 `CODEX_HOME` 或 `WHALE_HOME` 时使用对应目录；插件缓存更新不会覆盖用户素材与账本。

数据目录包含角色、音频、设置、账本、窗口状态、桌面服务配置和非敏感订阅额度快照。`quota-accounts.json` 保存额度账户（地址、密钥的存放位置、查询方式、价格），`quota-state.json` 保存当前额度与提醒状态，都不含密钥；旧版的 `api-settings.json` 原样保留以便回退。Codex 监控仅处理用量与任务状态；独立角色会话使用自己的 `chat-settings.json`、`chat-history.json` 和 `chat-billing.json`，密钥不写入这些文件。工作台设置保存在 `work-settings.json`，长期记忆保存在 `work-memory.json`，下发任务记录和审计保存在 `work-tasks.json`、`work-audit.jsonl`，摘要与复盘缓存在 `work-summaries.json`、`work-reports.json`；DSH 任务只读 `~/.dsh/storages/session_projcache` 的投影缓存，不修改 DSH 的会话文件。

素材限制、保存失败和损坏索引的保护见 [0.2.4 变更说明](docs/CHANGELOG-0.2.4.md) 与 [渲染实现](docs/RENDERING.md)。新导入受真实格式、尺寸/帧数及总量预算约束；已有素材不因超过新限制而被自动删除。

```bash
npm run check
npm test
npm run test:desktop
node scripts/control.mjs status
```

前三条验证命令在完整源码树中执行；桌面测试还需要已安装的 Electron 桌面组件及图形会话。测试使用独立临时数据，JSON 结果和截图保存至 `qa-output/`。发布包不含 `tests/`，请在源码目录执行测试。

macOS 可用以下命令检查桌面服务与余额链路：

```bash
npm run probe:mac
node scripts/control.mjs status
node scripts/control.mjs balance
```

## 仓库结构

```
.codex-plugin/plugin.json   Codex 插件清单（名称、版本、技能入口）
.mcp.json                   MCP 服务声明（无独立网页，仅本地管道）
package.json                包信息与快捷脚本
assets/                     whale-widget.js（挂件前端 bundle）+ 角色与音效素材
desktop/                    Electron 主进程、预加载、桌面服务监督器、页面脚本
desktop/ui/theme.*          三套主题的配色变量与切换；pet.css 是挂件、菜单和小窗的样式（见 docs/RENDERING.md）
desktop/ui/usage-*.js       前端额度请求与气泡文字（见 docs/USAGE-DISPLAY.md）
desktop/ui/quota-*.js       进度条、▾ 全部额度与额度管理窗口（见 docs/QUOTA.md）
desktop/ui/chat*.js         会话输入、流式事件消费、计费展示与显示定位（见 docs/CHAT.md）
desktop/ui/bubble-queue.js  系统气泡队列：优先级、停留时间与审批提醒抢占（见 docs/RENDERING.md）
desktop/ui/agents.*         任务小窗：会话行、详情卡、钉住／跟随与收起（见 docs/AGENTS.md）
desktop/ui/workbench.*      独立工作台窗口：任务列表、草稿、详情、记忆和设置
desktop/workbench-window.cjs 工作台窗口的创建、位置记忆与关闭行为
desktop/macos/              启动器与系统安全存储（macOS Keychain / Windows DPAPI）
runtime/                    余额与用量服务：配置解析、provider、账本、汇率、会话监视、MCP、IPC
runtime/quota/              额度簿：账户、额度窗口、消耗速度、记录与提醒（见 docs/QUOTA.md）
runtime/agents/             任务小窗的会话状态：Claude hooks 记录、DSH 投影缓存、排序规则与跳转（见 docs/AGENTS.md）
runtime/workbench/          工作台设置、Codex/DSH Runner、长期记忆与任务工具
runtime/chat/               独立角色会话、历史迁移、DeepSeek 请求与计费
runtime/chat/activity.mjs   主动闲聊调度；番茄钟状态的保存、到点触发与提醒队列
runtime/chat/pomodoro.mjs   番茄钟规则：阶段转换、数值范围、提醒身份与工具白名单，只处理值
runtime/chat/reply.mjs      生成一次回复：组装提示、工具调用与逐次请求记账，不写历史
lib/                        素材校验、资源库、widget 宿主，以及前后台共用的流式事件读取
scripts/                    安装/启动/停止/卸载/回滚与启动器编译
tests/                      关键行为测试与隔离桌面验证夹具
skills/                     Codex 技能说明（会话内调用 whale_* 工具）
docs/                       变更说明、验证报告、安装与回滚、迁移记录、渲染实现、原版说明
vendor/smol-toml            内置 TOML 解析（BSD-3-Clause）
vendor/eventsource-parser   内置流式事件解析（MIT）
```

## 仓库包含什么

**包含（可直接运行）**：`.codex-plugin/`、`assets/`、`desktop/`、`runtime/`、`lib/`、`scripts/`、`skills/`、`vendor/`、`docs/`、`LICENSE`、`PROVENANCE.md`、`THIRD_PARTY_NOTICES.md`、`package.json`、`.mcp.json`，以及 Windows `.cmd`、macOS `.command` 便捷入口和启动器 `.app`。源码仓库还包含 `tests/`。

**不包含**（有意排除）：

- `node_modules/`、`web/`、`qa-output/` 等依赖、开发与构建产物；发布包额外排除源码测试 `tests/`；
- 依赖作者本机备份的旧回滚脚本、历史调试文档与含本机时间戳的 `*-VALIDATION.json`——它们描述的是作者本机的升级过程，对其他人没有意义；
- 任何密钥、账号数据、用户账本：这些只存在于使用者本机的 `~/.codex/whale-widget`，仓库里没有也不需要。

## 反馈与安全

- **提问 / 报 Bug**：用仓库的 [issue 模板](.github/ISSUE_TEMPLATE/)（"问题反馈"里已列出需要附上的诊断文件，多数情况不需要贴日志正文）。
- **安全漏洞**：**不要开公开 issue**，请按 [SECURITY.md](SECURITY.md) 走 GitHub 私密漏洞报告或邮件；那里也写清了本插件的安全边界（哪些算漏洞、哪些是已知设计）。
- 报告里请勿包含真实 API 密钥、`auth.json`、`config.toml` 原文或完整账本。
