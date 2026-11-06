# 渲染实现

技术栈：Electron 44.3.0 / Chromium 152，DOM + SVG + CSS 合成；插件版本前缀为 0.2.4。

`desktop/main.cjs` 在启动前启用 GPU 光栅化，在 `gpu-info-update` 后记录实际合成状态。透明无边框窗口交给 Chromium 进行预乘 Alpha 合成；不重复乘 Alpha，也不绕过显卡驱动限制。`render-status.json` 可用于确认本机是否实际启用硬件加速。

`desktop/ui/input.js` 使用 `setIgnoreMouseEvents` 切换输入穿透，不裁剪窗口绘制区域。`mousemove` 转发与主进程鼠标位置补偿共同恢复悬停；按下后保持输入捕获，松开、取消或失焦时释放。弹窗、编辑器、菜单保持可操作。

`desktop/ui/alpha-worker.js` 在 Worker 中用一个复用的 OffscreenCanvas 解码、读取 Alpha，结果只用于输入检测。缓存按资源 URL（含版本参数）区分，最多保留 8 项 / 8 MiB。动画角色使用帧 Alpha 的并集；超过 120 帧的导入角色采用完整图片矩形作为输入区域，限制一次性解码开销。视觉本身不受输入区域影响。

`desktop/ui/render.js` 的 `BubbleRenderer` 是双缓冲渲染类：两个持久 DOM 层，隐藏层生成完整内容，等待图片和字体就绪，再用 160 毫秒交叉淡入淡出呈现。旧内容不提前删除。`switching` 与递增 `epoch` 一起拒绝过期异步回调；关闭和场景抢占取消过渡。解码失败时保留上一完整画面。

`assets/whale-widget.js` 中的 `sceneOpen` 是唯一场景入口。点击气泡只显示当前额度：订阅账户两个窗口左右并排，API 账户显示余额与今日消费，内容在场景入口一次读定。`refresh` 和用量回调仅更新数据，已显示气泡不因加载、成功或失败回调重新生成；下次打开时使用最新数据，当前账户变化时重开。系统气泡（任务完成、用量警告、审批提醒）由 `desktop/ui/bubble-queue.js` 排队：一次显示一个并打断点击气泡，其余按优先级等待；审批提醒立即显示并保留到点击，被打断的气泡回到队首；其他气泡的显示时间从画面就绪后开始计算；画不出来的气泡会被跳过，不再卡住后面的系统气泡；关闭任务费用气泡时，屏幕上和排队中的费用气泡一起清掉。`sceneOpen` 返回场景是否已显示。

镜像在鲸鱼根层使用原版 `transform .3s ease` 过渡，文本按相同时长反向镜像。命中检测读取当前矩阵，位置计算使用未压缩的尺寸。移动动画独立放在 `translate3d` 父层，按压动画保留在身体层。合成器自行呈现动画，JavaScript 不逐帧请求原生整窗重绘。

Windows 工具窗口标识把透明挂件排除在 Chromium 的宿主遮挡计算之外。保留正常激活，避免 `focusable:false` 导致首次鼠标按下被系统吞掉。金额显示换算使用独立状态和 DOM 文字绑定，重用气泡缓冲区前清除旧绑定。详细说明见 `UI-CURRENCY-RESTART-VERIFY-ROLLBACK.md`。

界面状态保存改为内存缓存与异步合并写入，避免鼠标路径中的同步磁盘写入。窗口首次初始化读取一次配置；正常退出时等待最后一次保存。

回归入口：`node --test tests/*.test.mjs`；`node scripts/smoke-desktop.mjs <输出目录>`。完整桌面回归需用 `WHALE_TEST_PYTHON` 指定本机 Python，以读取 Win32 标志和点击经过身份校验的测试窗口。桌面测试使用隔离的虚构余额，不读取真实 API 凭据。`WHALE_TEST_SCALE=1/1.25/1.5/2` 可分别测试显示缩放；`WHALE_RENDER_GRAPHICS_ONLY=1` 只运行图形相关检查。

气泡图片解码失败、慢解码和快速取消由测试注入；点击、拖动、窗口显隐、帧截图和透明区域穿透使用实际 Electron 窗口。帧截图能检查 Chromium 输出，仍需在实际显示器上复核最终桌面合成结果。

## 主题

`desktop/ui/theme.js` 在页面绘制前读取 `dshw-theme`，写到 `<html data-theme>`；菜单最上方的三个选项调用 `WhaleTheme.set` 切换，选择随其他 `dshw-` 键保存到 `ui-state.json`。`desktop/ui/theme.css` 定义三套主题的变量（底色、文字、强调色、进度条、圆角、描边、阴影、气泡填充与描边），以及深海夜光的面板反光和女仆墨蓝的蕾丝标题栏与蝴蝶结。其余样式表只引用这些变量：`ui.css`（对话框与表单）、`chat.css`（会话）、`quota.css`（进度条、全部额度、额度管理）和 `pet.css`（角色、点击气泡、菜单与编辑小窗）。点击气泡的 SVG 形状不变，填充、描边粗细和投影由主题决定；音频裁剪画布在绘制时读取同一组变量。
