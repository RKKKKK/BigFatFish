# 0.2.5 基线与回退

## 基线范围

- 分支：`free-desktop-pet`。
- 上一个已提交版本：`codex-v0.2.4` / `8de181a`。
- 本次固定标签：`codex-v0.2.5-baseline`。
- 包含当前 0.2.5 源码、桌面启动器与素材、已有及新增测试、验证与回退文档。
- 用户设置、账本、密钥、Electron 运行时和测试输出不在 Git 基线中。

这是本地开发基线，不是线上发布。后续模块重构应从此标签对应提交开始，保留标签不移动。

## 查看与取出

```bash
git show --stat codex-v0.2.5-baseline
git log --oneline codex-v0.2.4..codex-v0.2.5-baseline
git diff --stat codex-v0.2.5-baseline..HEAD
```

推荐在另一个工作目录取出基线，保留当前开发目录和未提交工作：

```bash
git worktree add --detach ../whale-0.2.5-baseline codex-v0.2.5-baseline
```

需要在基线上继续修复时，可改用：

```bash
git worktree add -b fix/0.2.5 ../whale-0.2.5-fix codex-v0.2.5-baseline
```

以上仅取出源码，不会切换正在运行的桌面服务。macOS LaunchAgent / Windows 计划任务引用安装时的源码路径；若确实要运行取出的版本，先停止原挂件，再在取出目录执行对应安装入口。macOS 用 `npm run install:mac`，Windows 用 `安装桌面组件.cmd` 与 `安装自动跟随.cmd`。安装会改变自启动项，不能只靠 Git 切换判断运行版本。

## 数据回退

Git 标签不恢复 `~/.codex/whale-widget`（Windows 对应用户目录下 `.codex\whale-widget`），也不恢复 Codex 的 `hooks.json`。使用了 `CODEX_HOME` / `WHALE_HOME` 时，以实际路径为准。

在以后涉及数据格式的升级前，停止挂件并备份数据目录和 `hooks.json`。加密密钥文件依赖原机器和用户的加密环境，不能当作跨机器可直接恢复的明文凭据。本次基线整理未操作正在使用的用户数据或自启动项。

## 验证入口

在完整源码目录中，使用 Node.js 24+：

```bash
npm run check
npm test
npm run test:desktop
```

桌面测试需要已安装的 Electron 桌面组件和可用图形会话；可通过 `WHALE_ELECTRON_PATH` 指定 Electron 可执行文件。测试使用短路径临时目录，不安装 hooks 或自启动服务，不查询真实 API。JSON 报告与截图位于 `qa-output/desktop-0.2.5-*`，不会进入 Git。测试观察浏览器的音频播放请求，不在你的桌面发出测试声音。

本次验证范围及未验证项见 [验证报告](VERIFICATION-0.2.5.md)。
