# ice-agent-console — 给 Agent 的工作说明

这个工程把 **ICE 家族**（`ice-render` / `@damoqiongqiu/ice-chart` / `@damoqiongqiu/ice-chart-dsl`）
接到 **AG-UI 协议**上：Agent 的事件流驱动 ICE 画布，图表以卡片形式内联在对话时间线里。

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

---

## 2. 分层与落点

**纯逻辑放 `src/domain/`，命令式放 `src/view/`，协议编解码放 `server/`。**

| 要改什么 | 改哪儿 |
|---|---|
| 事件怎么折叠成状态 | `src/domain/agui/reducer.ts` |
| JSON Patch / 追加识别 | `src/domain/agui/state-patch.ts` |
| SSE 解析 | `src/domain/agui/sse.ts` |
| 协议 → ICE 的纯翻译 | `src/domain/ice/option-mapping.ts` |
| 图表实例的建立与交互接线 | `src/view/chart-adapter.ts` |
| 卡片 DOM | `src/view/card.ts` |
| thread DOM 外壳 | `src/view/thread.ts` |
| 事件序列怎么生成 | `server/agents/dsl-to-events.ts` |
| 剧本（M2 会被模型替换） | `server/agents/scenarios.ts` |
| 自定义事件名 / context 键 | `shared/contract.ts` |

`reducer.ts` 是**纯函数 + effects**：它只描述要做什么，不碰 DOM。碰 canvas 的活在
`src/entries/boot.ts` 的 `applyEffects` 里。改归约逻辑时保持这个边界，否则归约器就没法单测了。

---

## 3. 协议约定（改之前必须知道）

- `EventType` 从 `@ag-ui/core` 取，**不要写字符串字面量**——拼错了会静默丢事件。
- 事件顺序是**先画后讲**：`TOOL_CALL_* → STATE_SNAPSHOT → 解说 + CUSTOM 指点`。
  `CUSTOM` 指点的对象是画布，画布得先在。改动顺序前先看 `tests/dsl-to-events.test.ts`。
- id 必须**跨 run 唯一**（当前是 `前缀_runId_序号`）。撞 id 会让前端拿第二轮的卡片顶掉第一轮的。
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
