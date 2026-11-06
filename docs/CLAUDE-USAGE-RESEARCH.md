# Claude 订阅用量接入研究

核查日期：2026-09-29。当前工作仅调查与记录；没有请求真实账户用量接口，没有读取 OAuth 凭据，也没有修改生产代码或 Claude 用户配置。

## 结论

可以为大肥鱼新增 Claude 订阅额度监控。首选 Claude Code 官方 `statusLine` 数据入口，接收 5 小时、每周已用百分比和重置时间，再适配挂件现有用量显示。官方在 2.1.80 加入这两组字段；本机安装的 2.1.284 已超过该版本。[官方更新记录](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)

本机已有的 Claude JSONL 会话记录只能支持本地 token 统计，不能据此推算账户订阅额度。账户额度与本地 token 数需要分别呈现。

## 官方数据入口

`statusLine.command` 接收 stdin JSON，以下字段描述订阅额度，而不是上下文占用：[官方 status line 文档](https://code.claude.com/docs/en/statusline#rate-limit-usage)

| 字段 | 含义 |
| --- | --- |
| `rate_limits.five_hour.used_percentage` | 5 小时已用百分比 |
| `rate_limits.five_hour.resets_at` | 该窗口重置时间，Unix 秒 |
| `rate_limits.seven_day.used_percentage` | 每周已用百分比 |
| `rate_limits.seven_day.resets_at` | 该窗口重置时间，Unix 秒 |

文档明确覆盖 claude.ai Pro/Max 订阅；首个 API 响应前没有 `rate_limits`，两组窗口可分别缺失，重置时间过去后窗口会移除。状态脚本本地运行，不消耗模型 token。[官方字段说明](https://code.claude.com/docs/en/statusline#available-data)

该脚本在会话开始、回复到达等事件时更新，也支持 `refreshInterval`。后者用于重复运行脚本；文档没有承诺每次重跑都会重新查询服务器额度，不能据此宣称挂件能实时捕捉其他设备的新消耗。[官方运行机制](https://code.claude.com/docs/en/statusline#how-status-lines-work)

## `/usage`、`/cost` 与账户额度

当前 `/usage` 同时显示会话费用、订阅额度和活动统计；`/cost`、`/stats` 已是其别名，因此“订阅用户不能用 `/cost`”不是当前准确表述。[官方命令列表](https://code.claude.com/docs/en/commands)

Session 美元数是按本地 token 和 API 价格计算的估算；Pro/Max 的正常使用包含在订阅中，这个美元数不能当作订阅扣费或剩余额度。额度查询失败时，Claude 自身也可能显示最近 60 分钟的旧快照并标注时间。[官方费用与旧快照说明](https://code.claude.com/docs/en/costs#using-the-usage-command)

Claude 网页、Claude Code、Claude Desktop 的使用共同计入账户使用限制，所以仅累计本机 Claude Code 日志不能完整重建账户额度。[官方使用限制说明](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work)

## 本机证据与边界

以下为主调查流程提供的本机只读元数据检查结果，不是官方所有版本的格式保证：

- `claude --version` 返回 2.1.284。
- 在沙箱外只读查询并仅保留状态字段后，确认已登录 `claude.ai`、使用官方提供方、订阅类型为 `pro`；没有输出凭据或账户身份。
- `~/.claude/projects` 当前有 1 个 JSONL，包含 33 处 assistant `message.usage`，字段包括输入、输出、缓存创建与缓存读取 token。
- 跳过消息正文后，元数据未发现 `rate_limit`、`five_hour`、`seven_day`、`utilization` 或 `resets_at`。
- 当前 `~/.claude/settings.json` 没有配置 `statusLine`。

安装程序包含上述状态字段名，支持接口存在的判断；尚未采集真实 status line payload，最终接入仍需用自然回复验证。

官方公开 `transcript_path` 作为会话记录路径，但这不代表 transcript 有官方保证的账户额度事件。因此不应直接复用 Codex 的 JSONL 额度解析器。[官方 hook 输入说明](https://code.claude.com/docs/en/hooks#common-input-fields)

## 非交互查询和 OAuth 接口

本次在官方 CLI 与平台文档中没有找到适用于个人 Pro/Max 订阅、可直接轮询额度的公开 REST 契约或 JSON 查询命令。`-p` 的公开用途是输出模型回复，不能未经验证就把 `claude -p /usage` 当作只读、无推理的查询接口。[官方 CLI 参考](https://code.claude.com/docs/en/cli-reference)

公开 Usage and Cost Admin API 面向组织 API 消耗，需要相应管理权限，且不适用于个人账户；它不能代替个人订阅的 5 小时和每周额度。[官方 Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)

内部 OAuth 用量路径是否继续可用、响应结构与第三方调用是否兼容，本次未取得官方公开契约，也未实际请求。不能把“未文档化”写成“官方已宣布废弃”。本次推荐方案无需读取钥匙串或管理 Claude 的登录令牌。

## 建议的项目接入方式

以下为针对当前仓库的实现建议，不是 Anthropic 要求：

1. 新增独立 Claude 数据适配器。状态脚本仅抽取额度窗口、版本、会话标识和采样时间，原子写入挂件自己的本地快照，不保存完整 stdin 或聊天正文。
2. 保留现有 Codex 采集器。按 `source` 分别保存 Codex/Claude 快照，用来源选择器切换；两家额度独立计算，不相加、不互相覆盖。
3. 复用桌面匹配和提示规则，把硬编码的 Codex 文案改为来源标签。5 小时和每周窗口分别处理；缺失显示待更新，过期显示未知，保留旧值时标注采样时间，不能伪装为 0%。
4. Claude 首次自然产生回复后建立额度快照。没有运行 Claude、尚无首个响应或从网页发生的后续消耗，可能没有及时刷新；“刷新挂件”应明确只是重读本地数据。
5. 状态脚本若需与用户已有配置并存，先备份，再把收到的 JSON 同时交给旧命令，并保持旧命令的输出。当前本机无旧配置，安装流程仍须支持将来的已有配置和回退。
6. 只采用文档保证的两组订阅窗口。单独模型限额、额外用量余额、完整账户身份不在该公开字段契约内，后续另行验证再增加；账户切换也需要明确的快照失效规则。

最低验证范围：两家来源切换、百分比单位、Unix 秒转毫秒、单窗口缺失、初始无数据、重置过期、并发/中断写入、旧状态脚本保留，以及真实 Claude 自然回复后与 `/usage` 的两组额度核对。
