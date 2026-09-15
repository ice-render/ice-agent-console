# 上游缺口清单

做这个工程的过程中，对**同级仓库**（`ice-render` / `ice-chart` / `ice-chart-dsl`）观察到的东西。

按约定：**本工程不擅自改上游**。这里只记两类东西——绕过的（A/B）和请求的（C/D）。
每条都带文件:行号、现象、本工程的处置。

条目按发现顺序编号，不按严重程度。

---

## 1. 【绕过】`renderChartDsl` 每次都重建图表实例

**位置**：`ice-chart-dsl/src/runtime/renderChartDsl.ts`

`renderChartDsl` 内部无条件 `createChart`。用在"一次渲染就完事"的场景没问题，
但**流式更新**（`STATE_SNAPSHOT` 反复到达）会不停泄漏图表实例；更麻烦的是
挂在实例上的交互监听会随之丢失——症状是"更新几次之后点了没反应"，
而且只在第 N 次更新后才出现，很难查。

**本工程处置**：不用 `renderChartDsl`，自己拆成
`validateChartDsl → compileChartDsl → createChart / setOption`，
实例只建一次（见 `src/view/chart-adapter.ts` 的 `mount`）。
`planAppend` 兜底全量重绘时也复用同一个实例。

**是否建议上游改**：不建议改现有语义——一次性用 `renderChartDsl` 是合理的便利函数。
如果将来要加东西，可以考虑补一个"绑定到已有实例"的入口，但本工程不需要。

---

## 2. 【绕过】`appendData` 不补类目轴的 `xAxis.data`

**位置**：`ice-chart/src/ICEChart.ts:376`（`appendData`）

`appendData` 只往 `series.data` 末尾 `concat`，**不碰 `xAxis.data`**。

- 数值轴 / 时间轴编译出来是 `xAxis.type='value'` + `series.data = [[x, y], ...]` —— `appendData` 完全适用。
- 类目轴编译出来是 `xAxis.type='category'` + `xAxis.data = ['1月', ...]` + `series.data = [120, ...]`（纯数值）。
  往这种轴追加一个**新类目**，`appendData` 只加了值、没加类目名，会错位。

**本工程处置**：`planAppend`（`src/domain/ice/option-mapping.ts`）认出类目轴就返回 `null`，
调用方退回全量 `setOption`。慢一点但一定对。
流式剧本（`实时吞吐量`）因此改用数值轴——那本来就是 `appendData` 被设计出来服务的场景
（函数注释里写的"实时数据流专用"）。

**是否建议上游改**：不建议。给 `appendData` 加"自动补类目轴"会让它的契约变模糊
（什么时候该补、补在哪一端？）。现在的契约是清晰的：它服务数值/时间轴。
如果将来要在类目轴上追加，更合适的形态是一个独立的 `appendCategory` 之类的入口。

---

## 3. 【绕过】没有用官方的 `@ag-ui/encoder`

**位置**：`@ag-ui/encoder@0.0.59` 的依赖

它依赖 `@ag-ui/core` + **`@ag-ui/proto`**（protobuf）。本工程只用 SSE，
帧格式是"一行 `data:` + 空行"。

**本工程处置**：自己写 `encodeSse`（`server/protocol.ts`，约 15 行），
server 侧运行时依赖收敛到只有 `@ag-ui/core`。

**是否建议上游改**：不建议。官方 encoder 要同时支持 SSE 和二进制通道，拖 protobuf 是合理设计。
只是对本工程来说不划算。

---

## 4. 【请求】`ChartEventName` 缺 `mark:drag` / `mark:dragend`

**位置**：`ice-chart/src/types.ts:893`（`ChartEventName` 联合类型）、`:909`（`ChartEventPayloads`）

`mark:drag` 和 `mark:dragend` **确实会被 emit**：

- `ice-chart/src/ICEChart.ts:538` — `this.emit('mark:drag', data)`
- `ice-chart/src/ICEChart.ts:582` — `this.emit('mark:dragend', ...)`
- `ice-chart/src/types.ts:816` 的注释也写了"拖动后……抛出 `mark:drag`"

但这两个名字**不在 `ChartEventName` 联合类型里，也不在 `ChartEventPayloads` 里**。

影响范围有限：`on(event: string, fn)` 的签名是宽类型（`ICEChart.ts:915`），所以运行时能用。
但任何拿 `ChartEventName` 做穷举、或写类型安全的事件监听表的地方，都会漏掉这两个事件——
**而且不会报错，只是静默漏掉**。

**本工程处置**：本轮没用到 mark 拖动（卡片粒度是「一次 tool call 一张卡片」，
而拖动标记属于「就地改历史」，跟 Thread 的追加语义冲突，见 README 第 6 节）。
所以这条**只是记录，没有阻塞**。

**是否建议上游改**：我倾向补上（把两个名字加进联合类型和 payload 表即可，`ChartMarkData` 已经存在），
但这是 `ice-chart` 的改动，属于你正在动的仓库——**等你定**。
我没有改任何上游文件。

---

## 5. 【观察，非缺陷】折线图的 `item:click` 命中区很窄

**位置**：交互层，非具体缺陷

柱状图的柱子是实心矩形，随便点都能中；折线图的命中区只有几个像素宽。
写 e2e 时这一点很实际：`期望点击触发一轮 run` 的用例在折线图上会变成随机红。

**本工程处置**：`e2e/helpers.ts` 的 `clickChartItem` 按一组实测位置依次尝试；
折线图那条用例改用框选（绘图区任意位置都能触发）。

**是否建议上游改**：不建议。这是折线图的正常语义。
真要改的话属于"放大命中区"的可配置项，跟本工程无关。

---

## 6. 【参考】家族包的本地解析方式：`paths` 而不是 `file:`

不是缺陷，是**本工程对家族既有实践的一处偏离**，记在这里以免以后困惑。

家族里的 `ice-entity-designer-react-demo` 用 `file:../ice-entity-designer` 链接。
那条路有记录在案的坑：`file:` 会让 npm 遍历被链接包的依赖树跑 `prepare`（会撞上某些包
锁定的老 typescript），而且它留下的 `node_modules` 软链在后续 install 时会写坏宿主工程的 `@types`。

本工程只用到三样东西：**运行时由 webpack 的 `resolve.alias` 负责，类型由 tsconfig 的 `paths` 负责，
测试由 jest 的 `moduleNameMapper` 负责**——三处都指向同级仓库目录，`node_modules` 里不塞任何东西。

代价：`npm install` 之后仍需要三个兄弟仓库各自 `npm run build` 生成 `dist/` 与 `dist/types/`。

---

## 7. 【请求】`ice-chart` 不接受外部 ICE 实例

**位置**：`ice-chart/src/ICEChart.ts:215-216`（构造函数里写死 `new ICE()`）、
`:106-111`（`ICEChartOptions` 只有 `renderMode` / `dpr` / `autoResize`）

`ICEChart` 在构造函数里自己 `new ICE()` 并 `init(target)`，**没有入口传一个已有的实例进来**。
所以图表**没法作为已有场景树里的一个子树**。

这一条在卡片加了控件层之后变成了**载荷性的**：它直接决定了"卡片里为什么是两块 canvas
而不是一块"。因为一张 canvas 上跑两个 ICE 实例不成立（两边都会认为整张画布是自己的，
各自的脏矩形与事件总线会互相打架），而图表又进不了别人的实例，所以只能是两张画布。

（顺带纠正一个容易读错的点：`ICE.init` 里的 `INIT_ALREADY_BOUND` 管的是
**同一个实例绑到两张画布**，跟"两个实例共用一张画布"无关 —— 后者不是被拦下的，是模型上不成立。）

**本工程处置**：两张 canvas 并排（图表一张、控件条一张），各自一个实例。
见 `README.md` §3.3 与 `src/domain/ice/layer.ts`。

**是否建议上游改**：这一条值得单独讨论，因为它是"要不要让 ICE 支持 A 型分层"的入口。
按之前的结论本工程**坚定走 B 路线**（多实例协作），所以**现在不需要改** ——
两张画布已经解决问题。但要把"图表作为子树"这条路明确记下来：

- 若将来想让控件**浮在图上**并与数据坐标绑定，`addMark` 已经够用（那是现成的槽位）；
- 若将来想要"一个场景树、多张画布"（A 型：Konva / ZRender 的做法），
  那是一次**渲染层**的改动（`ICE` 要持有多个渲染目标、渲染循环按 zlevel 分组派发、
  命中测试跨层统一），成本比 B 路线高一个量级，且要同时放弃"一个实例 = 一张画布"这个简单契约。

---

## 8. 【观察】`ICEPanel` 不能当布局容器用（它是"卡片底座"）

**位置**：`ice-web-components/src/components/ICEPanel.ts`（构造函数里**强制** `fill: true`、`stroke: true`、阴影）

做表单卡时踩到的：`compileFormDsl()` 最初用 `ICEPanel` 当外层容器（标题 / 说明 / 表单 /
提交按钮挂在它上面），结果画布上出现**一条压在标题身后的灰杠**。

原因是 `ICEPanel` 是"卡片底座"——它必然会画自己的填充与描边，而它自己的高度默认只有控件
那么高；于是那块背景被画成了压在第一个子节点身后的横条。它不是缺陷，是**用错了组件**。

**处置**：`ice-web-components-dsl` 0.1.1 起改用 `ICEGroup`（纯布局容器，
`setLayout` / `doLayout` / `getPreferredSize` / `addChild` 一应俱全）。
"外观交给宿主、容器只管布局"这条分界更清楚：本工程的外框是那条冰蓝竖线（DOM/CSS 画的）。

**是否建议上游改**：不建议。`ICEPanel` 的语义（卡片底座）是对的，
真正值得记的是"**`ICEGroup` 有全套布局 API，布局容器不必是 Panel**"——这条我没在上游文档里
看到明确说明，是从源码里读出来的。

---

## 9. 【已修】`fitCanvasToDisplaySize()` 改完尺寸不安排重绘 → 空闲停帧下 resize 静默白屏

**位置**：`ice-render/src/ICE.ts`（`fitCanvasToDisplaySize`）

给 canvas 的 `width` / `height` 赋值会**清空画布**。所以这个方法在把 backing store 对齐好的同时，
已经把画面抹掉了。而 2.12.0 只改尺寸、不置脏 —— 一旦画面已经画完、帧循环已经因为
「空闲停帧」（`ICE.needsFrame()`）停掉，就**没有任何人会再画一次**：
调用方拿到返回值 `true`，看到的却是一张白画布，不报错、不告警。

**怎么发现的**：在给表单卡补"缩窗口后重新对齐"的 e2e 时，A/B 掉 `FormLayer.fit()` 里那句
`setWidth()` 之后，表单整块变白（着墨包围盒量出来是 `null`，持续 5 秒）。
也就是说**它当时能画出来纯属巧合** —— `compiled.setWidth()` 里的 `doLayout()` 顺手置了脏。

**本工程处置**：已随 `ice-render` 2.12.1 修掉（改完尺寸自行 `this.dirty = true`，
setter 内部会 `FrameManager.wake()`）。这不是"顺手帮忙重绘"：清空是引擎在那一行里干的事，
补画的义务就属于引擎；留给调用方等于要求每个宿主都记住一条不成文的规矩，而漏掉的症状是静默白屏。
另外 2.12.0 那段 `@returns` 的措辞（"调用方据此跳过重排 / 重绘"）有误导性，也一并改了 ——
返回值只该用来决定**自己那层**要不要重新布局。

**是否建议上游改**：这一条已经修了，不需要再讨论。值得记的是**这类缺陷的形态**：
"引擎内部改了状态、却把配套动作留给调用方"，加上"不报错"，等于把一个必然踩的坑
埋在每个宿主脚下。同类的还有 `canvasWidth` / `canvasHeight` 手写（见 `README.md` §3.3）。

---

## 10. 【请求】`ice-web-components` 的宽度没有"父级拉满"的自动传导

**位置**：`ice-web-components/src/components/ICEForm.ts`（`ICEBoxLayout({ align: 'stretch' })`）、
`ICEFormItem.doLayout`（按 `control.state.width` 定位控件，不改变它）

宽度在 ICE 里是**每个组件自己的属性**，没有"父级拉满"的自动传导。
`ICEForm` 的 `align: 'stretch'` 拉的是 `ICEFormItem`，**不拉控件**；
`ICEFormItem.doLayout` 只按 `control.state.width`（缺省 `200`）**定位**控件。
于是只写 `align: 'stretch'` 对视觉结果完全没有作用，每个控件落到各自的出厂默认 ——
`ICETextField` 200、`ICEInputNumber` 140、`ICESelect` 200、`ICEButton` 112，
同一张表单里几个控件宽度还互不相同。

**本工程处置**：在 DSL 层兜住（`ice-web-components-dsl` 0.1.2）：
编译期给"意图级默认宽度"（竖向 = 表单宽度；横向 = `max(120, 宽 - 80)`，那 80 让给标签），
并补 `setWidth()` 供宿主在容器尺寸变化时整棵树重新对齐。
代价是**宽度要一层层显式写下去** —— 见 `ice-web-components-dsl/README.md` §8.1。

**是否建议上游改**：我倾向**不改**，跟 §7 是同一类判断。理由：

- `align: 'stretch'` 只摆位置、不缩放子组件，跟 Swing 的 `Container.setLayout` 语义一致
  （引擎注释里明确写了"父布局只摆位置，子容器用自己的策略排自己的子项"）——
  这是一条**清楚的**契约，改掉它反而会让"某个控件就该比别的窄"变得没法表达；
- 真正缺的是**文档**：从源码才能读出"`stretch` 不传导到控件"，而踩到的症状是
  "画出来了、但右边空掉 74%"——不会报错，只会被人说难看。
  建议在 `ICEForm` / `ICEBoxLayout` 的文档里写一句"`stretch` 作用于表单项，不改变控件的宽度"。

如果一定要在组件层改，最小改动是让 `ICEFormItem.doLayout` 在**没显式给控件宽度**时
把它拉到行宽（即把 DSL 现在做的事下沉一层）。但这会改变既有视觉结果，
而且"没显式给"这个判据在组件层不好判（`state.width` 总有默认值）——**不建议**。

---

## 11. 【观察】暗色主题：控件都能看，但层与层糊在一起 + 图表的提示框仍是白底

**位置**：`ice-web-components/src/theme/ICETheme.ts` 的 `ICE_DARK_THEME`；
`ice-chart/src/theme/chartTheme.ts` 的暗色主题

这一条是**实测出来的**，不是从代码读出来的 —— 过程值得记一下：这个工程一开始做成了暗色，
用户看了一眼说"组件层对 dark 支持不佳"，于是逐块截图核对：

**能看的**（截图确认过）：`ICESelect` 的下拉面板（深底 + 浅字 + 悬停行）、`ICEColorPicker` 的色板、
`ICESegmented` 的选中态、`ICEDateRangePicker` 的两头、`ICETransfer` 的两栏、
`ICEInputNumber` 的步进按钮、`ICERadioGroup`、表单的标签与错误行。

**没做好的两处**：

1. **层与层之间明度差太小。** 库里给的是 `background #212529` / `surface #2b3035` /
   `elevated #343a40`（Bootstrap 中性灰基调），相邻两档的明度差只有几个百分点。
   后果不是"某处看不清"，而是**卡片、控件、浮层糊成一片**，看不出层级 ——
   这类问题很难在单个组件上发现，只有把它们拼成一个界面才看得出来。
   （亮色主题没这个问题：`background #f8f9fa` / `surface #ffffff` 是纯白对浅灰，
   加上描边之后层级很清楚。）
2. **图表的提示框是白底。** 暗色图表上，悬停出来的是一个**纯白**圆角框 + 深色字
   （见本仓 README 暗色截图时期的那张 `hero`）。在深底上非常跳。
   位置上更接近 `ice-chart` 的 `chartTheme`（tooltip 的背景没有跟着 `dark` 走），
   而不是引擎或控件库 —— 但没往下挖到具体那一行，所以记成"观察"。

**本工程处置**：**默认改成 light**，暗色保留成 `?theme=dark` 供以后复查
（理由见 README §3.5：这件事要反复看才能真正判断，所以留了个不用改代码的口子）。

**是否建议上游改**：第 1 条改的是设计取向（把暗色的面拉大明度差，或者干脆换一套非 Bootstrap 的
暗色基准），不是缺陷修复，得你定；第 2 条是明确的缺陷，值得定位一下。
我自己**没有去挖**这两处 —— 本工程现在默认 light，它们不阻塞任何东西。

---

## 汇总

| # | 类型 | 条目 | 阻塞本工程？ |
|---|---|---|---|
| 1 | 绕过 | `renderChartDsl` 重建实例 | 否 |
| 2 | 绕过 | `appendData` 不补类目轴 | 否 |
| 3 | 绕过 | 官方 encoder 拖 protobuf | 否 |
| 4 | 请求 | `ChartEventName` 缺两个事件名 | 否（记录） |
| 5 | 观察 | 折线图命中区窄 | 否 |
| 6 | 参考 | 用 `paths` 而非 `file:` | 否 |
| 7 | 请求 | `ice-chart` 不接受外部 ICE | 否（改用两块画布绕开） |
| 8 | 观察 | `ICEPanel` 不能当布局容器（用 `ICEGroup`） | 否（已改用 ICEGroup） |
| 9 | 已修 | `fitCanvasToDisplaySize` 不置脏 → resize 静默白屏 | 否（`ice-render` 2.12.1 已修） |
| 10 | 请求 | 控件宽度没有"父级拉满"的传导 | 否（DSL 层兜住） |
| 11 | 观察 | 暗色主题层间明度差小 + 图表提示框仍是白底 | 否（默认改用 light，留 `?theme=dark`） |

**结论**：除了第 9 条（一个**引擎缺陷**，已在 2.12.1 修掉），其余都是"选择不那样用"
或"换个做法"。作为一次对 ICE 家族对外接口的真实集成测试，结果是：接口够用。

两处需要上游知道的（第 4、10 条）都不是缺功能，是**文档没说清楚**：
第 4 条是类型层面的补全，第 10 条是"`stretch` 不传导到控件"这条语义没写下来 ——
两者都是"不报错、只让人意外"的形态，也正是这个工程最值得记下来的收获。

