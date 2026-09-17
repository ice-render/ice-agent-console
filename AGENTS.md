# ice-agent-console — 给 Agent 的工作说明

这个工程把 **ICE 家族**（`ice-render` / `@damoqiongqiu/ice-chart` / `@damoqiongqiu/ice-chart-dsl` /
`ice-web-components` / `ice-web-components-dsl` / `ice-entity-designer`）
接到 **AG-UI 协议**上：Agent 的事件流驱动 ICE 画布。

**界面是反过来的**：绘图区是整页的主体（铺满视口、开页就画着工艺图），
对话是浮在它右边缘上的一块面板。切换界面 = 在绘图区里**换图层**，不是往消息流里插卡片。

改之前请先读 `README.md`（架构与边界）和 `docs/upstream-gaps.md`（对上游的观察）。

---

## 1. 硬约束

1. **不要改上游仓库。** `ice-render` / `ice-chart` / `ice-chart-dsl` 是同级目录里的独立仓库。
   在这个工程里发现上游缺陷时，写进 `docs/upstream-gaps.md`，不要顺手改。
2. **不要用 `file:` 依赖家族包。** 运行时靠 webpack `resolve.alias`、类型靠 tsconfig `paths`、
   测试靠 jest `moduleNameMapper`。装 `file:` 会引入有记录在案的 npm / symlink 问题。
3. **不要用 `renderChartDsl`。** 它每次 `createChart`，流式更新会泄漏实例并丢掉交互监听。
   用 `validateChartDsl → compileChartDsl → createChart / setOption`，实例只建一次。
4. **`appendData` 只能用在数值/时间轴。** 它不补 `xAxis.data`，类目轴追加新类目会错位。
   判不了就走全量 `setOption`（判断逻辑在 `src/domain/ice/option-mapping.ts`）。
5. **绘图区按 tool 名切图层，三种形态互斥。** `render_diagram` → diagram 图层
   （一块画布，`ice-entity-designer` 绘制）；`render_chart` → chart 图层
   （**两块**画布：图表 + 控件条，`ice-chart` + `ice-web-components`）；
   `collect_input` → form 图层（一块，`ice-web-components-dsl`）。
   写选择器时**必须用 `[data-kind=…]` 指明是哪一层**，不要靠 DOM 顺序
   （`e2e/helpers.ts` 的 `CHART_CANVAS` / `WIDGET_CANVAS` / `FORM_CANVAS` / `DIAGRAM_CANVAS`）。
   **diagram 图层永不销毁** —— 它是主视图，开页就建好，"切走再切回来不重画"是需求点名的；
   chart / form 是按需图层，被顶掉即**销毁**（不叠着留）。
   断言"有没有重画"用 `__iceAgentConsole.stageInfo().builds`，那是这件事的直接读数。
   图层之间是**并排**的（同一时刻只显示一个），不需要 `linkViewport` / `setInputPassthrough`。
5a. **画布命令走 CUSTOM，不走 tool call、不进 state。** 目前三条：`ice/point-at`
   （指着讲，`{ value, blink? }`）、`ice/point-clear`、`ice/zoom`
   （缩放视图，载荷是 `{ direction, factor?, steps?, scale? }`）。
   判据是"瞬时的演示动作，不是需要恢复的状态"—— 刷新页面后"当时放大到 1.4 倍"没有意义。
   **加一条命令 = 加一个事件名 + 一个 Effect + `applyEffects` 里一个 case + 归约器的
   合法性白名单**，与"加一种卡片"是两条独立的扩展路径（卡片改 state，命令不改）。
   ⚠️ **方向取值以 `shared/contract.ts` 的 `ZoomDirection` 为唯一出处**，
   别在别处再抄一份字面量联合（原先抄了 6 份，加方向时要记得改全，漏一处不报错）。
   ⚠️ 加新方向时**归约器那个 `if (direction === 'in' || …)` 白名单是最容易漏的一处**：
   漏了的话命令在协议里合法、视图层也实现了，却在归约器被当"非法方向"静默丢掉
   —— 症状是"讲稿说要把整张图框进来，画面停在上一档，零报错"（`fit` 就是这么踩的，
   `tests/reducer.test.ts` 有专门一条钉它）。
   ⚠️ 转交 effect 时**每个可选字段都要逐个带上** —— 漏一个的症状同上
   （踩过：`scale` 漏了，讲稿里推镜头的那几拍画面纹丝不动）。
   已知的取舍：`in`/`out` 是**相对**语义（人 / 模型不知道当前倍率）而讲稿用 `to`
   绝对倍率（相对倍率在十几拍里会累积到不可预期）；`reset` 回的是**初始视野**
   而不是 `scale = 1`；`blink` 与 `pointAt` 打在**同一条**事件上（拆两条会闪一帧）。
   ⚠️ **「看整张图」必须用 `direction: 'fit'`，不许拿 `to` 猜一个常数倍率。**
   `to` 只改倍率、**保留当前中心**（那是为了配合 `pointAt` 的"先居中再放大"），
   于是从别处推远到"全貌"时图纸中心不在屏幕中心上 —— 实测左侧 1870 世界像素被推出屏幕，
   而且画面看着只是个"远景"，不报错（详见 README §2.0.1）。
   `fit` 与界面上的「看整张图纸」共用 `DiagramLayer.__fitViewport()`。
5b. **图卡的 DSL 守卫在本仓**（`src/domain/diagram/`）。上游 `ice-entity-designer-dsl`
   **没有** water 编译器，所以那套 kind-first 的 DSL 定义在这里。
   它的校验器与另两张卡同口径：**永不抛、只给结构化诊断** —— 自修复回路靠这个文本。
   白名单（31 种符号 / 9 种介质）**从 `ice-entity-designer` 转发，不要在本仓复制**，
   否则上游加一种符号就会两边不一致（agent 吐的合法载荷被自家校验器判成非法）。
   另外：`server/` 那套 tsconfig 不加载 DOM，所以 `shared/` 里**只能放类型**，
   运行时的白名单留在 `src/domain/diagram/`。
5c. **浮在画布上的 DOM 面板必须 `stopPropagation`。** 引擎在 `window` 上装了**全局**事件
   拦截器（`DOMEventInterceptor`），把所有指针 / 滚轮事件**广播给每一个 ICE 实例**，
   唯一的过滤是"事件目标是不是另一块 **canvas**"。对话面板是个 `<div>`，不在过滤范围内 ——
   不额外拦一道的话，在面板上滚一下，画布那个实例照样当成一次滚轮缩放。
   好在拦截器挂的是**冒泡阶段**，所以在面板根上拦一次就行（见 `src/view/chat.ts` 的
   `shieldFromCanvas`，由 `boot.ts` 装在 `#chat` 上 —— **整个面板**，不只是消息区；
   面板底那排家族链接因此在覆盖范围内）。**别拦键盘** —— 输入框一直是这样工作的。
   e2e 有一条正反两面的断言（面板上滚无效 / 画布上滚有效）。
   ⚠️ **别拿滚轮判断这道屏蔽有没有用**：工艺图的滚轮缩放是直接挂在 canvas 元素上的
   （`diagram-layer.ts`），目标是面板时根本到不了它 —— 实测"在面板上滚，图纹丝不动"
   在**摘掉屏蔽**时同样成立。它真正挡的是**走引擎事件总线的悬停 / 命中**：
   2026-09-16 拿图表图层验过正反两面 —— 摘掉屏蔽后，鼠标在面板上划过（面板压在图表画布上），
   图表的提示框会跟着变；装回去就一动不动。**面板里加东西自动被覆盖，
   加到面板外面的浮层要自己再拦一次。**
5d. **改图走 `STATE_DELTA` + JSON Patch，不要自造"图元增删事件"。**
   "state 变了"协议里已经有词（`STATE_DELTA` + RFC 6902）。补丁按**形状**分流
   （`src/domain/agui/state-patch.ts` 的两个纯函数）：只往 rows 追加 → `appendData`；
   只增删 `/diagram/units` `/diagram/pipes` → **增量**（`createSymbol` / `designer.remove`，
   图层不重建、视口不重置）；其它 → 全量重建。
   两条**实测踩过**的坑：
   - **渲染层的级联 ≠ 文档的一致性**。`designer.remove(unitId)` 会顺手删掉两端的连线，
     画面是干净的；但 JSON Patch 只管 `units` 数组，**管线数组原封不动** ——
     文档里会留下悬空管线。所以补丁要**表达完整意图**（删单元要连带列它的管线，
     还要把 `viewport.focus` 里的它摘掉）。`detectDiagramPatch` 允许 focus 的删除，
     但**不允许**它被当成"碰了别的东西"而退回全量。
   - **下标会变，而 `remove` 一个存在的下标不报错**。`STATE_DELTA` 顺序应用，
     前一批删完之后后一批的下标已经前移。所以编补丁要用 `scenarios.ts` 里的
     `IndexCursor`（维护 id 镜像、**降序删**）。用基准图的下标编第二批会静默删错管线。
   层里那个 `this.doc` 在 `applyPatch` 之后要换成**补丁后**那份（`__focusBox()` 读它）。
6. **中断轮的结束状态是 `waiting`，不是 `idle`。** 协议里中断**也是** `RUN_FINISHED`。
   所以 e2e 里不能用 `settleAfter`（它等 `idle`）去等一次中断 —— 永远等不到。
7. **恢复中断 = 开新 run + 带 `resume`**，不是"接着跑"。
   形状从 `@ag-ui/core` 的 schema 问出来的：`{ interruptId, status: 'resolved' | 'cancelled', payload? }`。
8. **e2e 点快捷按钮要用 `chipLocator()`（精确匹配），不要用 `.chip` + `hasText`。**
   按钮里有一对只差三个字的（`故意画错` / `故意画错工艺图`），而 `hasText` 是**子串**
   匹配 —— 它会同时命中两个，再 `.first()` 就等价于"按 DOM 顺序取第一个"。
   这个写法把"测试点的是哪个按钮"绑在了**排版顺序**上（踩过：把工艺图那组调到最前之后
   立刻响，报出来的却是 `Cannot read properties of undefined (reading 'y')`，
   完全看不出是点错了按钮）。按钮的**分组与顺序**另有一条 e2e 钉着。
9. **对话面板的自动滚动是"有条件跟随"，别改成一律滚到底。**
   一律滚到底会让面板没法往回读（流式文本每秒来十几次，用户翻不上去）。
   实现见 `src/view/chat.ts`：`scroll` 里量距底距离维持 `stickToBottom`，
   渲染**写完 DOM 之后**才跟（提前滚会滚到旧的 `scrollHeight`），
   而且是**瞬时跳**不是 `smooth`（平滑动画会被下一条流式消息打断，永远落在后面）。
   `scroll` 事件的派发是异步的，所以 e2e 改完 `scrollTop` 要等一拍
   （`helpers.ts` 的 `scrollChatTo()` 已经代劳）。
10. **演示模式（纯前端）只许依赖 `server/agents/` 里那四个纯文件。**
   `scripted.ts` / `scenarios.ts` / `dsl-to-events.ts` / `types.ts` 能在浏览器里跑
   （零 node API），演示模式（`?demo=1` / `build:demo`）就是把它们搬进页面。
   同目录的 `llm.ts` / `llm-client.ts` / `tools.ts` 与上层的 `index.ts` / `config.ts`
   是**真 node-only**（`node:http` / `fs` / `process.env`）—— 碰了会把浏览器包搞坏，
   症状是打包期一堆 node polyfill 找不到、或者打出一个巨大的假包。
   两条 transport 共用 `src/domain/agui/run-input.ts` 的输入映射与 `RunTransport` 签名，
   **别各拼一份输入**（`resume` 空数组不带那个条件很容易漏）；
   取消语义也要一致（`AbortError` 静默返回、不当错误上报）。
   开关是"构建期默认 + 运行期覆盖"两级，见 `src/domain/agui/transport.ts`。
   模式判定必须能被单测，所以 `globalThis.location` 只在 boot.ts 里读、不进纯函数。
11. **canvas 里没有 DOM 目标可定位。** 要测"点中某个控件"，走
   `__iceAgentConsole.widgetRects()`（应用挂出来的矩形查询），不要写死像素偏移 ——
   按钮宽度是按文案字数算的，改一个字就全错位。
12. **改动 UI 之后要重跑 `npm run shoot`，截图是提交进仓库的产物。**
   它坏掉不会让任何测试变红 —— 只是 README 里挂着一张过期或错误的图。
   已经因此踩过两次，两条都写进 `scripts/shoot-docs.cjs` 的注释里了：
   - **点快捷按钮必须精确匹配文案**（同第 8 条）。脚本坏掉的那次，失败点在**几步之后**
     的 `onLayer('chart')` 超时上，完全看不出是点错了按钮；
   - **"拍到高亮"要等闪烁底块处于亮的那半周期**，否则可能拍在最暗那一帧
     —— 黄框几乎透明，而截图本身不会报错。
   另外：**宣传"同一张图没重画"的对照图，拍之前要清掉残留高亮**
   （`clearPoint()`）—— 讲解剧本讲完是**留着**高亮的，定妆照上挂个黄框会让读者
   以为那是某种标注。
13. **状态字段"存在"不等于"用户看得见"—— 失败必须落在对话流里。**
   `state.error` 一直都在（`RUN_ERROR` 时置位），但原先只被拼进顶栏 meta 那行小字
   （`… · 工具 0 · 出错 · Failed to fetch`）。于是失败时用户看到的是
   "我发了一句话，然后什么都没发生" —— 像 AI 不理人。实测路径：打开静态站点的
   `?demo=0`（走后端 transport 而站点上没有后端），点任意按钮就停在那个状态。
   现在 `ChatView` 会在 `#thread` 末尾挂一张 `.error-notice`：一句人话 + 下一步动作
   （`?demo=1`），**同时保留原始报错**（给开发者查原因，只给人话会让本地真配错的人无从下手）。
   ⚠️ 它是**状态**不是 thread 里的一条消息，所以不进 `items`。
   这条的普遍形式：**加了状态字段之后，回头确认它有没有被渲染**；
   `getState()` 读得到 ≠ 界面上有。e2e 里那条用 `page.route('**/agui').abort()` 造失败
   （别依赖"某个端口恰好没起"，那在本地与 CI 行为不一致）。
14. **开页自动开演（`?autoplay=`）必须是"可让位"的。** 演示产物默认开页自己演一遍
   （见 `src/domain/agui/autoplay.ts`），但 `send()` 有 `if (running) return` 的护栏 ——
   不主动取消的话，那 19 秒里点按钮 / 打字会被**静默吞掉**，页面看着能点其实没反应。
   所以任何"不是自动开演"的 `send` 进来时先 `cancelAutoplay()` 并**等那一轮真的停下来**
   （取消是异步的，不 await 就还是会被护栏吞）。
   三条配套事实：
   - 自动开演那一轮**带 `AbortSignal`**；其余轮次不带（没有取消入口）。
   - 被掐掉那半截消息**保留** —— 它是真发生过的事，抹掉反而让人看不懂。
   - **不需要**额外"把 status 推回 idle"的动作：会走到取消的只有"用户抢在前面动了手"，
     而那一下必定接着开新一轮 run。实测过（去掉它用例照样过）——
     但**以后若加了不跟着开 run 的取消入口（比如 Esc 停止），这里就得补上**。
   开关是"构建期默认 + 运行期覆盖"两级，与 `?demo=` / `?theme=` 同一口径；
   构建期默认还额外要求 `RUN_MODE === 'demo'`（否则演示构建上 `?demo=0` 会自动弹错误卡）。
   ⚠️ 改 UI 之后跑 `npm run shoot`（第 12 条）时它已经带上 `?autoplay=0`，别去掉。
15. **工艺图的布局不许"图元压住图元"，而且这件事是可断言的 —— 改坐标前后都跑那条用例。**
   判据在 `src/domain/diagram/layout.ts`（纯函数）+ `tests/diagram-layout.test.ts`：
   零重叠、两两间隙 ≥20px、每单元摊到的世界面积有下限（基础图与提标后的图各判一遍）。
   ⚠️ **"占多大"必须按落墨盒算，不能用引擎的 `getMinBoundingBox()`**：
   那个方法**不算子节点**，而位号/名称是子节点、还刻意画在盒子外面，
   宽度是 `max(w + 24, 90)`（32 宽的阀门 → 90 宽的文字盒，左右各溢出 29px）。
   用错会得出"0 处重叠"这个**假结论** —— 比量不出来更危险，第一版就是这么错的。
   调坐标的流程：`scripts/layout-model.mjs`（离线模型，与单测同一套公式）
   + `scripts/layout-sandbox.mjs`（试缩放系数），秒级迭代，别靠反复开浏览器。
   ⚠️ **绝对像素/绝对倍率类的判据会随"图的世界尺寸"过期**：
   放开间距（世界尺寸 ×1.75）之后，"开页有图"那条着墨判据从 >20000 掉到 12439 而变红。
   现在改成**覆盖率**（着墨 ÷ 可视区面积）。同理 `minScale` 也得跟着图的大小走
   （当前 0.085，判据是"要能把整张图缩进可视区"）。
   还有一类**应用层解决不了**的：管线标注钉在折线顶点上、引擎没有偏移入口，
   所以"标注压住符号文字"对间距是尺度不变的（放大到 2.2 倍数量一动不动）。
   记在 `docs/upstream-gaps.md` 第 16 条，别再去试"放大间距"这条死路。
16. **TDK / 爬虫可见性只动那三个静态文件，别在 JS 里拼。**
    整页主体是 canvas，DOM 里没有正文，所以"这页能不能被搜到"全落在
    `public/index.html`（head 的 TDK + 末尾 `#site-summary` 那份文字替身）、
    `public/robots.txt`、`public/sitemap.xml` 上。三条硬约束：
    - **运行期不许改 `document.title`。** 演示构建开页会自动开演、图层会切走，
      标题跟着画面走就变成"取决于播放到第几拍"，每次抓取都不一样
      （`tests/seo.test.ts` 扫 `src/` 钉住这条，不是靠自觉）。
    - **文字替身不许用 `display:none` / `visibility:hidden` 藏**（连无障碍树与一部分
      爬虫一起跳过，等于白写），也**不许写成关键词堆砌** —— 它是"给 canvas 配 alt"，
      不是关键词栏。文案里的数字（68 单元 / 81 段管线）由单测从 `shared/water-process-case.ts`
      对着真实数量判，改图忘了改文案会红。
    - **站点地址在四个文件里各出现一次**：canonical、`og:url`、sitemap 的 `<loc>`、
      robots 的 `Sitemap:`。改域名要一起改 —— 两处测试（`tests/seo.test.ts` 读源码、
      `e2e/seo.spec.ts` 读产物）会红。
    `public/` 下除 `index.html` 之外的文件由 webpack 的 `CopyPublicFiles` 原样搬进 `dist/`，
    部署时**整份 dist/ 拷进 gh-pages** —— 别再往部署脚本里加文件白名单：
    漏一个的症状是线上 404、而构建日志全绿。改完跑 `npm run deploy:pages -- --dry`，
    第 2b 步会逐条验（含"og:image 指向的文件真的在产物里"）。
    ⚠️ **发版之后再跑一次 `npm run seo:check`**：发版前那套自检看的是"这次构建的产物"，
    这个看的是"线上现在是什么"。站点**不跟 main 走**、而且**每次部署都是整份覆盖** ——
    源码推完以为上线了、或下一次部署把 TDK 覆盖回旧状态，只有它看得出来。
17. **第三方脚本（现在的 GA4）只在非本地环境加载，而且判定必须在运行期。**
    页面的 head 里那段 GA 外面套了一层 `location.hostname` 判断（见 README §12.7）。
    两条都别动：
    - **判据必须是运行期**：e2e 跑的**正是 production 产物**（`npm run build` 的 dist，
      只是用 localhost 提供），构建期开关**挡不住它**。
    - **判据必须是黑名单（排除 local）不是白名单（只认线上域名）**：白名单在换自定义域名时
      静默失效（统计没了、零报错），黑名单最多是多打几次。
    ⚠️ 门控失效的症状是"**整个 e2e 套件自己红**"，而且**跟网络好坏无关**：`collectErrors`
    把 `requestfailed` 当错误，而 GA 即使在完全正常工作时，自己那些重复 beacon 也会被
    Chromium 记成 `net::ERR_ABORTED`（实测：`gtag/js` 200、`g/collect` 204、
    另两条 collect 是 ERR_ABORTED）。`e2e/seo.spec.ts` 有一条用例钉住它。

18. **应用层写法：一页 = 一个类（2026-09-17 确立）。**
    家族的应用层统一到这个形状（库侧是 `ice-web-components` 的 `ICEContainer` 契约，
    `ice-smart-water` 的 12 个页面、各仓示例页都这么写；游戏页见 `ice-game` 的 `GamePage`）。
    本仓**只有一屏**（绘图区铺满视口 + 对话面板浮着），所以**入口即页面**：
    `src/entries/boot.ts` 就是 `class AgentConsolePage` —— 构造期按原顺序装配、
    方法承载动作、文件末尾 `new AgentConsolePage()`（与 `ice-game` 的 `src/home/main.ts` 同形）。

   - **DOM 抓手**：`const x = document.getElementById(…)` 落成局部变量 → 在守卫里收窄 →
     赋给 `private readonly x: HTMLElement`。所以方法里**不用**写 `this.metaEl!` 那种非空断言。
   - **纯常量**（`CHIP_GROUPS` / `WIDGET_ACTIONS` / `WIDGET_PROMPTS` / `AUTOPLAY_DELAY_MS`）
     走 `private static readonly`，引用处写 `AgentConsolePage.xxx`。
   - **状态一律是实例字段**（`state` / `running` / `pendingDiagnostics` / `failedTool` /
     `autoRepairUsed` / `autoplayAbort` / `autoplayDone`）—— 别再摊回模块顶层。
   - ⚠️ **构造期的顺序是承重的，别顺手排序**：`installTheme()` 必须在造任何组件之前、
     `syncPanelInset()` 必须在画工艺图之前、调试句柄挂完最后才自动开演。
     搬进构造期时注释跟着搬，顺序一字未动。
   - 棘轮：`tests/pageConvention.test.ts`（恰好一个类 / 无模块级 `function`、`let` /
     文件末尾实例化 / 状态在实例上）。smart-water 那种"宿主 + 12 页"是**另一个形状**
     （那边入口是宿主，页面在 `src/view/pages/`），别拿它当反例。
   - 改造时踩的坑：**机械替换必须避开字符串与注释**。裸名换 `this.x` 时把
     `getElementById('stage')` 改成了 `'this.stage'`、把状态字符串 `'running'` 改成了
     `'this.running'` —— 构造函数当场抛错、调试句柄没挂上，症状是 **55 条 e2e 全红**
     且报的是"`__iceAgentConsole` 不存在"，完全看不出根因。注释里夹着的 `state` /
     `transport` / `running` 一样会被误改（中文注释里还常有反引号包的代码片段）。

---

## 成员顺序（2026-09-17 定，全家族同口径）

类里的成员按这个顺序排 —— 就是棘轮里那个正则 `S*F*C*A*T*M*`：

```
static 常量/字段  →  实例字段  →  构造函数  →  访问器 get/set  →  static 方法  →  实例方法
```

- **只到这一层**：不查 public/private 的先后，也不查同组内谁先谁后。理由不是偷懒 ——
  Google Java Style §3.4.2 明确说 class 成员顺序"**没有唯一正确的配方**"（原文：
  "there's no single correct recipe for how to do it… each class uses *some logical order,
  which its maintainer could explain if asked*"），而 Google 的 TypeScript 指南对顺序
  **完全沉默**（全文 "ordering" 出现 0 次，只要求构造函数上下各留一个空行）。
  所以只把"讲得通"的骨架机器化，剩下的交给作者判断。
- ⚠️ **TS 跟 Java 不一样，挪位置前先分清挪的是什么**：
  **方法随便挪**（类定义时方法就全部装好，与文本顺序无关，静态方法同理）；
  **字段的声明顺序是有语义的** —— 初始化按声明顺序执行，还影响 V8 的 class shape
  （Google 的 TS 指南也专门点了这条）。所以挪 `static` 字段要确认它跟别的
  `static` 字段/静态块之间没有顺序依赖，挪实例字段要确认初始化表达式互不依赖。
  本仓这次只挪了 4 个互相独立的常量，外加一个注释归位，**归一化比对逐行一致**。
- 棘轮：`tests/pageConvention.test.ts` 的最后一条（`AgentConsolePage` 的成员序列）。
- 本仓的应用层就一个文件（`src/entries/boot.ts`），已经是这个形状；
  `src/view/` 与 `src/domain/` 是图层与纯逻辑，不在此口径内。

---

## 2. 分层与落点

**纯逻辑放 `src/domain/`，命令式放 `src/view/`，协议编解码放 `server/`。**

| 要改什么 | 改哪儿 |
|---|---|
| 事件怎么折叠成状态 | `src/domain/agui/reducer.ts` |
| JSON Patch / 追加识别 | `src/domain/agui/state-patch.ts` |
| SSE 解析 | `src/domain/agui/sse.ts` |
| 协议 → ICE 的纯翻译 | `src/domain/ice/option-mapping.ts` |
| 图 DSL 的校验 / 编译（纯逻辑） | `src/domain/diagram/{types,validate,compile}.ts` |
| 图 DSL 的结构类型（server 也要用） | `shared/diagram.ts` |
| **绘图区**（铺满视口 + 图层切换 + 内容比对复用 + 增量改图落点） | `src/view/stage.ts` |
| 「这批补丁是追加行 / 增删图元 / 其它」的识别（纯逻辑） | `src/domain/agui/state-patch.ts` |
| 工艺图图层（ice-entity-designer 的画布） | `src/view/diagram-layer.ts` |
| 内置案例：污水处理工艺图（68 单元 / 81 管线，会被剧本增删） | `shared/water-process-case.ts` |
| **图元有没有压住 / 挤不挤**（落墨盒 + 重叠检测，纯逻辑） | `src/domain/diagram/layout.ts` |
| 调坐标用的离线沙盘（试缩放系数、不启浏览器） | `scripts/layout-model.mjs` + `scripts/layout-sandbox.mjs` |
| 层（canvas + ICE 实例）的尺寸与生命周期 | `src/domain/ice/layer.ts` |
| 图表实例的建立与交互接线 | `src/view/chart-adapter.ts` |
| 控件层（图表卡的第二块画布，ice-web-components） | `src/view/widget-layer.ts` |
| 表单层（表单卡的画布，ice-web-components-dsl） | `src/view/form-layer.ts` |
| 对话里的**工具条目**（只有外壳，没有画布） | `src/view/tool-entry.ts` |
| 中断 / resume 的归约 | `src/domain/agui/reducer.ts` |
| 对话面板 DOM 外壳（含浮层的 stopPropagation） | `src/view/chat.ts` |
| TDK / 分享卡片 / 结构化数据（**静态 HTML，别用 JS 拼**） | `public/index.html` 的 `head` |
| canvas 的文字替身（爬虫读到的正文） | `public/index.html` 末尾的 `#site-summary` |
| 爬虫入口：规则 + 站点地图（站点根目录的文件） | `public/robots.txt` + `public/sitemap.xml` |
| 静态文件怎么进 dist/（`public/` → `dist/`） | `webpack.config.js` 的 `CopyPublicFiles` |
| **线上** TDK / 爬虫体检（发版后再跑一遍） | `npm run seo:check`（`scripts/seo-check.mjs`） |
| TDK / 爬虫字段怎么读（两个脚本共用一份） | `scripts/lib/html-audit.mjs` |
| 流量统计（GA4，**只在非本地加载**） | `public/index.html` 的 head（见 README §12.7） |
| 事件序列怎么生成 | `server/agents/dsl-to-events.ts` |
| 剧本（M2 会被模型替换） | `server/agents/scenarios.ts` |
| 自定义事件名 / context 键 | `shared/contract.ts` |
| **页面本身**（装配 / 状态 / 交互 / 布局 / 调试句柄） | `src/entries/boot.ts` 的 `AgentConsolePage`（见第 18 条） |

`reducer.ts` 是**纯函数 + effects**：它只描述要做什么，不碰 DOM。碰 canvas 的活在
`AgentConsolePage.applyEffects()`（`src/entries/boot.ts`）里（它把 effect **打给 `StageView`**，
effect 的形状没变、只是落点从"最后一张卡片"换成了"绘图区当前那一层"）。
改归约逻辑时保持这个边界，否则归约器就没法单测了。

---

## 3. 协议约定（改之前必须知道）

- `EventType` 从 `@ag-ui/core` 取，**不要写字符串字面量**——拼错了会静默丢事件。
- 事件顺序是**先画后讲**：`TOOL_CALL_* → STATE_SNAPSHOT → 解说 + CUSTOM 指点`。
  `CUSTOM` 指点的对象是绘图区**当前那一层**，所以那一层得先在。
  改动顺序前先看 `tests/dsl-to-events.test.ts`。
- id 必须**跨 run 唯一**（当前是 `前缀_runId_序号`）。撞 id 会让前端拿第二轮的条目顶掉第一轮的。
- `state` 存的是**完整状态文档**（`{chart: ...}`），不是拆出来的 chart——
  JSON Patch 的 path 是相对根的。
- 不认识的事件**丢弃**；不认识的 patch 操作**抛异常**。前者是协议要求的容错，后者是状态分叉。

---

## 4. 验证

```bash
npm run verify        # types:check + jest + build
npm run verify:full   # 上面 + playwright
```

前置：三个兄弟仓库要先 `npm run build`（需要它们的 `dist/` 与 `dist/types/`）。

新增行为时要**自设计单测**。归约器和事件序列编译器的用例都在 `tests/`，
e2e 的判据不要只看"DOM 里有没有元素"——canvas 全白是很典型的一种失败，要数像素。
