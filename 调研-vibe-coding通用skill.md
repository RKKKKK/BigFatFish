# 调研：vibe coding 还值得装的通用 skill

> 前提：先分清三种东西，不然后面全是糊涂账。
> - **rules / AGENTS.md / CLAUDE.md**：常驻上下文，每次都加载。适合"永远要遵守"的东西（编码纪律、目录约定）。
> - **skill（SKILL.md）**：按需加载。启动时只把 `name + description` 塞进上下文（约 100 token/个），命中任务才读正文。适合"做某类事时才需要的方法论"。规范见 [agentskills.io](https://agentskills.io/specification)。
> - **MCP**：跑起来的服务，提供工具。适合"要连外部系统"。
>
> 下面只谈 skill，并假设你已经有了"反过度防御"那一类（见另一份调研）。

## 一、按开发阶段分

| 阶段 | Skill | 出处 | 解决什么 |
| --- | --- | --- | --- |
| **想清楚 / 记计划** | `planning-with-files` | [OthmanAdi](https://github.com/OthmanAdi/planning-with-files)（生态里 star 最高，13k+） | 把 `task_plan.md` / `findings.md` / `progress.md` 写进磁盘当工作记忆。规矩是：先建计划、每两次检索就把结论落盘、做决定前重读计划、失败不重来。专治"跑到一半忘了最初要干什么" |
| | `brainstorming` / `writing-plans` | [obra/superpowers](https://github.com/obra/superpowers) | 需求澄清 → 可执行计划，动手前先把方案摊开 |
| | `intent-discipline` | [Mathews-Tom/armory](https://github.com/Mathews-Tom/armory/blob/main/rules/intent-discipline/RULE.md) | 别替用户默默假设；歧义先摊开 |
| **写代码** | `core-engineering`（9 个） | [dralgorhythm/claude-agentic-framework](https://github.com/dralgorhythm/claude-agentic-framework) | TDD、debugging、refactoring、implementing、testing、optimizing、依赖管理、数据层、数据到 UI。每个都短（<2500 字符），纯方法论不绑语言 |
| | `ai-coding-discipline` / `minimal-code-discipline` | 见另一份调研 | 反过度防御、YAGNI 阶梯 |
| **验证 / 收尾** | `verification-before-completion` | superpowers | 逼你先跑通、拿到证据再说"完成"，不许嘴上完成 |
| | `webapp-testing` | [anthropics/skills](https://github.com/anthropics/skills)（官方） | 用程序化方式点网页、断言行为，不靠肉眼 |
| | `verify` | [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) | 同类的"改动是否真生效" |
| **审查** | `requesting-code-review` / `receiving-code-review` | superpowers | 会提审查请求，也会正确接收批评（不辩解、先改） |
| | GitHub PR review skill | [aidankinzett](https://github.com/aidankinzett/claude-git-pr-skill) | 用 `gh` 做像样的 PR 评审 |
| **上下文 / 文档** | `deepinit` | oh-my-claudecode | 给一个陌生仓库生成分层 `AGENTS.md`，让 agent 进门就懂结构 |
| | `doc-coauthoring` / `writing-skills` | 官方 / superpowers | 写需求文档、以及**自己造 skill**（这个最值得，见下） |
| **前端 / 设计** | `frontend-design` | 官方 | 避免生成"一眼 AI"的默认审美 |
| | `web-quality-skills`（6 个） | [addyosmani](https://github.com/addyosmani/web-quality-skills) | 性能、Core Web Vitals、可访问性、SEO、web 最佳实践、综合审计。带具体预算（页面 <1.5MB、JS <300KB 等） |
| **办公产物** | `docx` / `xlsx` / `pptx` / `pdf` | 官方 | 真·生成 Office 文件与 PDF，不是贴 markdown |
| **并行 / 多代理** | `dispatching-parallel-agents` / `subagent-driven-development` | superpowers | 什么时候该拆给子代理、怎么防它们互相踩 |
| **Git 卫生** | `using-git-worktrees` / `finishing-a-development-branch` | superpowers | 并行改多个分支不互相污染；收尾时干净合回去 |

## 二、如果只装 5 个

按"覆盖面 / 维护成本"排，我会选：

1. **planning-with-files** —— 长任务不跑偏，ROI 最高，且和模型无关。
2. **superpowers 里的 brainstorming + writing-plans + verification-before-completion** —— 一个集合，覆盖"想清楚 / 有计划 / 敢验证"。
3. **core-engineering** —— TDD 和 debugging 是 vibe coding 最缺的两块肌肉。
4. **frontend-design**（如果你做界面）或 **web-quality-skills**（如果你在意上线质量）。
5. **writing-skills** —— 让你能把"自己的那套做法"沉淀成 skill，比装别人的都值。

其余按项目类型补：做 Office 产物加官方四个文档 skill；做基础设施加 [HashiCorp agent-skills](https://github.com/hashicorp/agent-skills)。

## 三、装之前必须知道的两件事

**1. 装多了会反噬。** 每个 skill 的 description 都占上下文（~100 token），装 30 个就是 3000 token 起步，而且模型要在相似描述里挑，命中率会掉。**同类只留一个**（比如反防御只留 ai-coding-discipline，别再叠 minimal-code-discipline）。

**2. 供应链风险是真实的。** Snyk 的 ToxicSkills 研究在测试的 skill 里发现 **36% 存在 prompt injection**、累计 1467 个恶意载荷。skill 本质是"会被模型当指令执行的文本 + 可能带脚本"，等于给第三方代码开了个后门。所以：

- 装之前通读 `SKILL.md`，尤其看有没有让你"忽略之前的指令""把密钥发到某处"
- 带 `scripts/` 的，逐个看脚本
- 优先选官方（anthropics/skills、hashicorp）和高 star 仓库
- 项目级装（`.claude/skills/`）比全局装更好审

## 四、怎么判断一个 skill 值不值得留

1. **它有没有一条能被检验的规矩？** "写得简洁点"没有；"删除实现后测试必须失败"有。
2. **它会不会和已有的规则打架？** 两份 TDD 规则同时在场，模型会在中间摇摆。
3. **它能不能一句话说清触发场景？** description 模糊的 skill 命中率极低，装了等于没装。
4. **最近三个月有没有人维护？** agent skill 的格式还在变。

## 五、参考

- [Agent Skills 规范](https://agentskills.io/specification) / [Anthropic 官方 skills 仓库](https://github.com/anthropics/skills)
- [obra/superpowers](https://github.com/obra/superpowers)（15 个，方法论向）
- [OthmanAdi/planning-with-files](https://github.com/OthmanAdi/planning-with-files)
- [dralgorhythm/claude-agentic-framework](https://github.com/dralgorhythm/claude-agentic-framework)
- [addyosmani/web-quality-skills](https://github.com/addyosmani/web-quality-skills)
- [hashicorp/agent-skills](https://github.com/hashicorp/agent-skills)
- [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)（50+ 个，流程向）
- [Snyk：Top 8 Claude Skills for Developers](https://snyk.io/articles/top-claude-skills-developers/)（含 ToxicSkills 数据）
