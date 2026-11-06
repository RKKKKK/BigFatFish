# 调研：哪些 skill 能压住 AI 的"过度防御"

> 说明：这里说的不是经典意义上的 defensive programming（校验外部输入、处理 IO 失败，那是必要的），
> 而是 AI 写代码时那种**兜底成瘾**：给不会抛错的代码包 try/catch、给不可能为空的字段加 `?? 0`、
> 一遍遍 `if (x && x.length)`、为想象中未来的第二个实现者先抽一层接口，同时把真正该做的超时、
> 限流、幂等全漏掉。社区里管这个叫 **defensive overdose** 或 **code slop**。

## 一、直接对得上这个问题的 skill

| Skill | 来源 | 它管什么 | 强度 |
| --- | --- | --- | --- |
| **ai-coding-discipline** | [luoling8192/ai-coding-principles](https://github.com/luoling8192/ai-coding-principles/blob/main/ai-coding-discipline/SKILL.md) | 6 条硬规则：禁止静默兜底、禁止业务逻辑里的 catch-all、测试必须能在实现被删时失败、禁止硬编码查表实现、修 bug 先写红测试、修复时不许顺手删调试日志 | 最对口，几乎就是为"过度防御"写的 |
| **code-slop** | [voku/agent-skills](https://github.com/voku/agent-skills/blob/main/skills/code-slop/rules/_sections.md) | 把 AI 味的代码分成 6 类，其中第 4 类 **Defensive overdose** 原话是：给不可能抛错的代码包 try/catch、在非空断言后还查 null、同一个函数里三次 `if (array && array.length)`，"而真正的防御——外部调用的超时、限流、熔断——反而没有" | 高，且顺带治注释/命名/测试的 AI 味 |
| **intent-discipline** | [Mathews-Tom/armory](https://github.com/Mathews-Tom/armory/blob/main/rules/intent-discipline/RULE.md) | 针对 Karpathy 总结的四类 LLM 编码失败：默默替用户假设、膨胀的抽象、顺手重构、验证标准太弱。要求"最小可用代码 + 外科手术式 diff + 可验证的成功标准" | 高，偏"范围控制"，能顺带抑制过度设计 |
| **yagni** | [5uck1ess/devkit](https://skillsmp.com/creators/5uck1ess/devkit/skills-yagni)（另有多个创作者的同名 skill） | 只做今天要的东西：反"以防万一"的抽象、反提前配置化（重试次数先硬编码）、反投机性泛化、反无证据的提前优化 | 中高，专治"未来的第二个实现" |
| **minimal-code-discipline** | [oh-my-claudecode](https://skills-hub.ai/skills/oh-my-claudecode-minimal-code-discipline) | YAGNI 阶梯：先看存不存在、能复用就别写、依赖也走阶梯、只写最短的正确 diff；另列一批"不许最小化掉"的底线 | 中，偏流程约束 |
| **ai-slop-cleaner** | 同上作者 | 清理已经写出来的 slop，删除优先、带回归保护 | 中，用于事后打扫 |

## 二、看起来相关、但解决的是别的问题

- **obra/superpowers**（[仓库](https://github.com/obra/superpowers)）有 `test-driven-development`、`verification-before-completion`、`writing-plans` 等 15 个 skill，**没有**专门反防御的。它能间接帮忙：TDD 会让"多余的 if"没地方藏，verification 会逼你先跑通再说完成。
- **throwaway-prototype**（[agentpatterns](https://raw.githubusercontent.com/agentpatterns-ai/website/refs/heads/main/workflows/throwaway-prototype-skill.md)）：只保留结论、扔掉原型代码，治"原型代码顺手变成生产代码"。

## 三、这些 skill 的共同内核（五条）

不管装哪一个，真正起作用的是下面五条，抄进自己的规则里也一样有效：

1. **只在边界兜底**：外部输入、网络/文件 IO、用户可见的展示，这三处才配兜底。
2. **内部契约不满足就抛**：函数拿到的参数不符合约定，抛错比 `?? 0` 更有价值——它让 bug 在原地暴露，而不是流到下游变成脏数据。
3. **每个兜底都要能说出"为什么这里可能是空/可能失败"**：说不出来，就是防御性噪音。
4. **没有第二个实现者就不抽象**：接口、配置项、插件点，等到真的出现第二个再抽，那时候你才知道真正的共性是什么。
5. **真防御优先于假防御**：超时、重试上限、幂等键、限流，比给 `JSON.parse` 包三层 try 有用得多。

## 四、落地建议（按我踩过的坑排序）

1. **只装一个主规则 + 一个按需 skill**。rules 常驻上下文，装三份互相重复的规则，最后是模型在规则之间打架、还占掉上下文。
2. **常驻规则放 AGENTS.md / CLAUDE.md 这种每次都在的位置**，把"提交前自检清单"写进去；按需 skill 用来处理特定任务（大重构、清理存量）。
3. **规则要可验证**。写"不要过度防御"没用，写"业务函数里出现 try/catch 必须能指出它在处理哪种具名错误，否则删掉"才有用。
4. **配一条反向白名单**，否则容易滑到另一个极端：
   - 用户输入解析、第三方接口返回、配置文件读取：必须有校验和兜底
   - 面向用户的展示：允许占位符、允许默认文案
   - 有文档记录的默认值：允许
5. **review 时用同一份清单**，而不是让 AI 自己说"我已经很克制了"。

## 五、可直接粘贴的最小规则块

```text
【防御性代码的边界】
只在三种地方兜底：外部输入（用户、网络、文件、第三方接口）、可能失败的 IO、面向用户的展示。
业务逻辑内部：契约不满足就抛错，不要用 ??、||、?. 把缺失值悄悄变成 0、空串或空数组。
每个 try/catch 必须能说出它捕获哪种具名错误、捕获后做什么；说不出来就删掉。
每个兜底必须能说出"这里为什么可能为空/失败"；说不出来就是噪音。
没有第二个实现者之前，不抽接口、不加配置项、不做兼容层。
真正的防御优先级更高：外部调用的超时、重试上限、幂等、限流，比包 try/catch 重要。
提交前自检：如果删掉这段兜底，程序会在哪里出错？如果答案是"不会"，删掉它。
```

## 六、参考链接

- [ai-coding-discipline/SKILL.md](https://github.com/luoling8192/ai-coding-principles/blob/main/ai-coding-discipline/SKILL.md)
- [code-slop 规则目录](https://github.com/voku/agent-skills/blob/main/skills/code-slop/rules/_sections.md)
- [intent-discipline RULE.md](https://github.com/Mathews-Tom/armory/blob/main/rules/intent-discipline/RULE.md)
- [yagni（5uck1ess/devkit）](https://skillsmp.com/creators/5uck1ess/devkit/skills-yagni)
- [minimal-code-discipline](https://skills-hub.ai/skills/oh-my-claudecode-minimal-code-discipline)
- [obra/superpowers](https://github.com/obra/superpowers)
- [Karpathy 关于 LLM 编码问题的原始观察](https://x.com/karpathy/status/2015883857489522876)

> 注：除 ai-coding-discipline、code-slop、intent-discipline、yagni 我读到了原文，其余几条
> （minimal-code-discipline、ai-slop-cleaner、throwaway-prototype）只核对了仓库/注册页的描述，
> 没读到 SKILL.md 正文。
