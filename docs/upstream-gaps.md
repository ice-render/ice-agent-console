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

## 汇总

| # | 类型 | 条目 | 阻塞本工程？ |
|---|---|---|---|
| 1 | 绕过 | `renderChartDsl` 重建实例 | 否 |
| 2 | 绕过 | `appendData` 不补类目轴 | 否 |
| 3 | 绕过 | 官方 encoder 拖 protobuf | 否 |
| 4 | 请求 | `ChartEventName` 缺两个事件名 | 否（记录） |
| 5 | 观察 | 折线图命中区窄 | 否 |
| 6 | 参考 | 用 `paths` 而非 `file:` | 否 |

**结论**：这个工程**全程没有改过任何一个上游仓库**。作为一次对 ICE 家族对外接口的
真实集成测试，结果是：接口够用——三条绕过都是"选择不那样用"，而不是"缺东西"。
唯一一条真正的请求是第 4 条，而且它是类型层面的补全，不影响运行时。
