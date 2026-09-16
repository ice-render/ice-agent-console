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
5c. **浮在画布上的 DOM 面板必须 `stopPropagation`。** 引擎在 `window` 上装了**全局**事件
   拦截器（`DOMEventInterceptor`），把所有指针 / 滚轮事件**广播给每一个 ICE 实例**，
   唯一的过滤是"事件目标是不是另一块 **canvas**"。对话面板是个 `<div>`，不在过滤范围内 ——
   不额外拦一道的话，在面板上滚一下，画布那个实例照样当成一次滚轮缩放。
   好在拦截器挂的是**冒泡阶段**，所以在面板根上拦一次就行（见 `src/view/chat.ts` 的
   `SHIELDED_EVENTS`）。**别拦键盘** —— 输入框一直是这样工作的。
   e2e 有一条正反两面的断言（面板上滚无效 / 画布上滚有效）。
5a. **画布命令走 CUSTOM，不走 tool call、不进 state。** 目前三条：`ice/point-at`
   （指着讲，`{ value, blink? }`）、`ice/point-clear`、`ice/zoom`
   （缩放视图，`{ direction: 'in'|'out'|'reset', factor?, steps? }`）。
   判据是"瞬时的演示动作，不是需要恢复的状态"—— 刷新页面后"当时放大到 1.4 倍"没有意义。
   **加一条命令 = 加一个事件名 + 一个 Effect + `applyEffects` 里一个 case**，
   与"加一种卡片"是两条独立的扩展路径（卡片改 state，命令不改）。
   两个已知的取舍：缩放是**相对**语义（agent 不知道当前倍率）、`reset` 回的是**初始视野**
   而不是 `scale = 1`；`blink` 与 `pointAt` 打在**同一条**事件上（拆两条会闪一帧）。
5b. **图卡的 DSL 守卫在本仓**（`src/domain/diagram/`）。上游 `ice-entity-designer-dsl`
   **没有** water 编译器，所以那套 kind-first 的 DSL 定义在这里。
   它的校验器与另两张卡同口径：**永不抛、只给结构化诊断** —— 自修复回路靠这个文本。
   白名单（31 种符号 / 9 种介质）**从 `ice-entity-designer` 转发，不要在本仓复制**，
   否则上游加一种符号就会两边不一致（agent 吐的合法载荷被自家校验器判成非法）。
   另外：`server/` 那套 tsconfig 不加载 DOM，所以 `shared/` 里**只能放类型**，
   运行时的白名单留在 `src/domain/diagram/`。
6. **中断轮的结束状态是 `waiting`，不是 `idle`。** 协议里中断**也是** `RUN_FINISHED`。
   所以 e2e 里不能用 `settleAfter`（它等 `idle`）去等一次中断 —— 永远等不到。
7. **恢复中断 = 开新 run + 带 `resume`**，不是"接着跑"。
   形状从 `@ag-ui/core` 的 schema 问出来的：`{ interruptId, status: 'resolved' | 'cancelled', payload? }`。
6. **canvas 里没有 DOM 目标可定位。** 要测"点中某个控件"，走
   `__iceAgentConsole.widgetRects()`（应用挂出来的矩形查询），不要写死像素偏移 ——
   按钮宽度是按文案字数算的，改一个字就全错位。

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
| **绘图区**（铺满视口 + 图层切换 + 内容比对复用） | `src/view/stage.ts` |
| 工艺图图层（ice-entity-designer 的画布） | `src/view/diagram-layer.ts` |
| 内置案例：污水处理工艺图（34 单元 / 37 管线） | `shared/water-process-case.ts` |
| 层（canvas + ICE 实例）的尺寸与生命周期 | `src/domain/ice/layer.ts` |
| 图表实例的建立与交互接线 | `src/view/chart-adapter.ts` |
| 控件层（图表卡的第二块画布，ice-web-components） | `src/view/widget-layer.ts` |
| 表单层（表单卡的画布，ice-web-components-dsl） | `src/view/form-layer.ts` |
| 对话里的**工具条目**（只有外壳，没有画布） | `src/view/tool-entry.ts` |
| 中断 / resume 的归约 | `src/domain/agui/reducer.ts` |
| 对话面板 DOM 外壳（含浮层的 stopPropagation） | `src/view/chat.ts` |
| 事件序列怎么生成 | `server/agents/dsl-to-events.ts` |
| 剧本（M2 会被模型替换） | `server/agents/scenarios.ts` |
| 自定义事件名 / context 键 | `shared/contract.ts` |

`reducer.ts` 是**纯函数 + effects**：它只描述要做什么，不碰 DOM。碰 canvas 的活在
`src/entries/boot.ts` 的 `applyEffects` 里（它把 effect **打给 `StageView`**，
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
