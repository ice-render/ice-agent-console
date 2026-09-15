# ice-agent-console

把 **ICE 家族**接到 **AG-UI 协议**上：Agent 的事件流驱动 ICE 画布，图表以卡片形式**内联在对话时间线里**。

一个最小可运行实例。没有模型（M1 阶段），后端是一个确定性的规则 agent——但**协议链路、渲染链路、
往返链路全是真的**。换成真模型只需要替换"把自然语言变成图表计划"那一小块。

```
┌─────────────┐   POST /agui (RunAgentInput)   ┌──────────────────┐
│  浏览器      │ ─────────────────────────────► │  AG-UI endpoint  │
│             │                                │  (node:http)     │
│  DOM thread │ ◄───── SSE 事件流 ──────────── │  ScriptedAgent   │
│  + canvas   │                                └──────────────────┘
└─────────────┘
   ICE 负责卡片里的图
```

---

## 1. 快速开始

前置：三个兄弟仓库要先构建过（工程不装它们的 npm 包，直接指向同级目录）。

```bash
# 在 ice-render/ 目录下
ls ice-render/dist/index.cjs ice-chart/dist/index.cjs ice-chart-dsl/dist/index.cjs  # 都应在

cd ice-agent-console
npm install
npm run dev          # 同时起 AG-UI 后端(8093) 和前端 dev server(8094)
```

打开 http://localhost:8094 。界面上有四个快捷按钮，对应四个剧本：

| 按钮 | 演示什么 |
|---|---|
| 看看各渠道的月度销量 | 主链路：文字流式 → 参数流式拼装 → 上画布 → **指着 3 月讲** |
| 看一下实时吞吐量 | `STATE_DELTA` → `appendData` 快路径，同一张图逐拍长数据 |
| 故意画错 | **自修复回路**：坏 DSL → 诊断回灌 → agent 自动吐修正版 |
| 今天天气怎么样 | 兜底：不画图，只回文字 |

**也可以在图上直接操作**：点柱子、或框选一段区间 → 会触发新一轮 run，
你的操作作为结构化上下文上报给 agent。

```bash
npm run serve        # 只跑静态产物（仍需后端在跑）
```

---

## 2. 它演示了什么

四条回路，都是这个工程存在的理由：

### 2.1 单向：事件流驱动画布

`TOOL_CALL_ARGS` 是**分片流式**的，所以卡片里能看到图表 DSL 一个字一个字拼出来——
而不是像多数工具调用界面那样只能转个圈。拼完 → `validateChartDsl` → `compileChartDsl`
→ 挂到画布上。

### 2.2 单向：Agent 指着图讲

`showHoverAtValue(x)` 让 Agent 能在解说过程中把高亮点移到某处。
事件流是**有序**的，所以文字 delta 和画布指令在时间上交错到达——
用户读到哪里，图就指到哪里。这是 ICE 在这条链路上最不可替代的能力。

### 2.3 双向：用户在图上的操作回到 agent

点数据点（`item:click`）、框选区间（`brush:end`）→ 作为**结构化上下文**塞进下一轮 run
的 `context` 字段，而不是拼进用户说的话里。

分开的意义：agent 分得清哪部分是"用户做的"、哪部分是"用户说的"。
接上模型之后，提示词里可以给"用户动作"一个明确的地位。

### 2.4 双向：诊断回灌的自修复

`ice-chart-dsl` 的 `validateChartDsl` **任何输入都不抛异常**，它的设计目的就是
"给 agent 做自修复用的反馈通道"——诊断里带可用列名、表达式字符位置。

这条回路把它用起来：坏 DSL → 客户端校验拦下 → 诊断走 `context` 回灌 →
agent 吐修正版 → 画出来。**全程自动，用户不用再说话。**

脚本化阶段就把这条回路走通，意义在于 M2 接真模型时回路上的每一段都已经测过了。
那时候唯一的变量只剩"模型这次吐的对不对"——而这个定位能力在 LLM 应用里最值钱，
因为平时你分不清是模型的问题还是管道的问题。

---

## 3. 架构

### 3.1 三层

| 层 | 位置 | 职责 |
|---|---|---|
| 协议层 | `server/`、`src/domain/agui/` | AG-UI 事件的编解码、归约 |
| 翻译层 | `server/agents/dsl-to-events.ts`、`src/domain/ice/` | "想画什么" ↔ "事件序列" ↔ "ICE 调用" |
| 渲染层 | `src/view/` | DOM thread 外壳 + canvas 卡片 |

### 3.2 一个刻意的分界：DOM 外壳 + canvas 内容

`ice-web-components` 的立场是 "every pixel drawn by the engine"，但它适合的是
应用外壳、表单、弹窗这类自成一体的画布界面。Thread 式消息流不行：
消息要能选中复制、要能走输入法、要有浏览器原生的滚动惯性、要能被屏幕阅读器读。

所以**DOM 管 thread 外壳（消息列表/滚动/输入框/卡片容器），canvas 管卡片内容（图表）**。
这个工程不是纯 canvas 应用，这是有意为之。

### 3.3 纯核心 + 命令式外壳

`src/domain/agui/reducer.ts` 是**纯函数**，返回 `{state, effects}`：
它只描述"要做什么"，不碰 DOM。碰 canvas 的活在 `src/entries/boot.ts` 的 `applyEffects` 里。

这样归约器可以被穷举测试（连"边画边指"的事件顺序都能断言），而 canvas 脏活留在需要它的地方。

---

## 4. 协议 → ICE 的映射表

**这张表是这个工程的全部价值**，剩下的都是管道。

| AG-UI 事件 | ICE 侧动作 | 备注 |
|---|---|---|
| `RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR` | 状态机 | |
| `TEXT_MESSAGE_*` | 纯 DOM 气泡 | 这层不需要 ICE |
| `TOOL_CALL_START/ARGS/END` | 卡片：参数流式拼装 → 解析成 DSL | `ARGS` 分片可见 |
| `TOOL_CALL_RESULT` | 卡片进入终态 | |
| `STATE_SNAPSHOT` | `compileChartDsl` → `setOption`（**同一实例**） | 快照是替换语义 |
| `STATE_DELTA` | JSON Patch → 纯追加走 `appendData`，否则全量 `setOption` | 见 §5.2 |
| `CUSTOM: ice/point-at` | `showHoverAtValue(x)` | 指着讲 |
| 上行 `item:click` | → 新 run，`context` 带结构化交互 | 见 §2.3 |
| 上行 `brush:end` | → 新 run，`context` 带选区 | 同上 |

### 4.1 事件顺序：先画后讲

```
RUN_STARTED
[intro]              一句话说明要干什么
TOOL_CALL_START ─ ARGS×n ─ END     参数流式分片
TOOL_CALL_RESULT
STATE_SNAPSHOT                     画布真相
[beats]              画完之后的解说（可插 CUSTOM 指点 / STATE_DELTA 追加）
RUN_FINISHED
```

**为什么不是"边说边画"**：`CUSTOM` 指点的对象是画布，画布得先在。
第一版把解说全排在 tool call 前面，结果指点事件到达时图上什么都没有——
前端只能缓冲，而缓冲意味着"指着讲"和文字不再同步，整个演示效果就没了。
`tests/dsl-to-events.test.ts` 里有一条测试专门盯这个顺序。

---

## 5. 两处必须知道的 ICE 侧约束

### 5.1 不要用 `renderChartDsl`

它内部每次都 `createChart`。用在流式更新上会不停泄漏图表实例，
而且挂在上面的交互监听会随之丢失——症状是"更新几次之后点了没反应"，
只在第 N 次更新后才出现。

本工程拆成 `validateChartDsl → compileChartDsl → createChart / setOption`，实例只建一次。

### 5.2 `appendData` 只能用在数值/时间轴

它只往 `series.data` 末尾 `concat`，**不碰 `xAxis.data`**。

- 数值轴：`series.data = [[x, y], ...]` → 适用
- 类目轴：`xAxis.data = ['1月', ...]` + `series.data = [120, ...]` → 往这类轴追加**新类目**会错位

所以 `planAppend`（`src/domain/ice/option-mapping.ts`）认出类目轴就返回 `null`，
调用方退回全量重绘。慢一点但一定对——判错不会当场报错，只会在某个时刻以
"图怎么不对"的形式浮现，那种 bug 最难查。

"实时吞吐量"那个剧本因此用数值轴（秒）而不是类目轴（月份）。
这不是为了演示好看，是 `appendData` 的注释里写明的"实时数据流专用"场景。

---

## 6. 明确不做的

范围边界，写下来免得被当成遗漏：

1. **不做真模型。** M1 是确定性的规则 agent。接口（`AgentRun`）已经留好，见 §10。
2. **不做 mark 拖动改历史。** `addMark` + `mark:drag` 是 ICE 独有的能力，但它属于
   **就地改历史**，跟 Thread"消息发出即定"的语义冲突。真要做得改设计
   （建议方向：拖动不写回原卡片，而是追加一条新消息触发新 run）。
3. **不做历史卡片冻结。** 目前所有卡片都是活的。往上滚的旧卡片仍可交互——
   这在卡片少的时候没问题，卡片多了需要一个"只有最新一张是活的"策略。
4. **不做 thread 持久化。** 刷新即清空。`threadId` 已经按协议在用，但没存。
5. **不做 reasoning / subagent / activity 事件。** 协议里有，本工程没用。
   归约器对未知事件是丢弃语义，所以它们不会导致崩溃，只是不显示。
6. **不用 `ice-web-components`。** M1 只用到引擎 + 图表 + DSL 三个包。
   人机回环（interrupt）要用到表单时才是它上场的时候。

---

## 7. 目录结构

```
ice-agent-console/
├── server/                  AG-UI endpoint（原生 node:http，运行时只依赖 @ag-ui/core）
│   ├── index.ts             路由、SSE、错误处理、取消
│   ├── protocol.ts          SSE 帧编码
│   └── agents/
│       ├── types.ts         AgentRun 接口 ← M1/M2 的分界线
│       ├── dsl-to-events.ts 图表计划 → 事件序列 ← M1/M2 共享
│       ├── scenarios.ts     剧本（规则）← M2 会被模型替换
│       └── scripted.ts      确定性 agent + 播放节奏
├── src/
│   ├── domain/              纯逻辑，无 DOM
│   │   ├── agui/            SSE 解析 / 归约器 / JSON Patch
│   │   └── ice/             协议 → ICE 的纯翻译
│   ├── view/                DOM 外壳 + canvas 卡片
│   └── entries/boot.ts      接线：分发动作、执行 effects、触发 run
├── shared/contract.ts       自定义事件名 / context 键（server 与 web 的唯一出处）
├── tests/  e2e/             jest 单测 + playwright
└── docs/upstream-gaps.md    对上游的观察
```

---

## 8. 工程约定

### 8.1 家族包怎么解析（三处，都不用 `file:`）

| 用途 | 机制 |
|---|---|
| 运行时打包 | webpack `resolve.alias` → 同级仓库目录 |
| 类型检查 | tsconfig `paths` → 同级仓库目录 |
| 单测 | jest `moduleNameMapper` → 同级仓库的 `dist/index.cjs` |

`node_modules` 里不塞任何家族包。理由与代价见 `docs/upstream-gaps.md` 第 6 条。

**alias 是为了强制单实例**：各包的 `node_modules` 里可能躺着版本不同的 `ice-render` 副本，
解析出多份引擎会让 `typeId` 注册表错位（`ice-chart` 造出来的图元在引擎眼里不是"同一个 ICE 的组件"）。

### 8.2 双 tsconfig

- `tsconfig.json`（web + tests + e2e）：DOM lib
- `tsconfig.server.json`（server + shared）：**故意不加载 DOM lib**

后者不是形式主义：它让 `document` / `window` 在 server 代码里**直接编译失败**。
agent 后端跑在 Node 里，误用浏览器 API 只会在运行时炸，而且往往只在某个分支上
（比如只在出错路径里用了 `document`）。

### 8.3 端口

8093（AG-UI 后端） / 8094（页面）。与家族其它仓库错开：
引擎 8090 / 实体设计器 8091 / smart-water 8092 / game 8098。

### 8.4 不用 dev-server 反向代理

前端**直连** `http://localhost:8093/agui`，后端开 CORS。
SSE 经中间层容易被缓冲，出问题时很难判断是协议问题还是代理问题。

---

## 9. 验证

```bash
npm run verify        # types:check(两个 tsconfig) + jest + build
npm run verify:full   # 上面 + playwright
```

当前规模：

| 项 | 数字 |
|---|---|
| 单测 | **91 passed** / 6 suites |
| e2e | **12 passed** / 4 specs |
| 源码 | 2334 行（`server` + `src` + `shared`，含注释） |
| 测试 | 1557 行（`tests` + `e2e`） |
| 生产包 | 622 KiB（引擎 282 + 图表 281 + DSL 19 + 应用 234，未压缩） |

e2e 的判据**不是"DOM 里有没有 canvas"**——canvas 元素存在但全白是很典型的一种失败。
用例一律数**非透明像素**，并断言画布内容在某些事件前后**确实变了**（比如"指着讲"）。

另外每条用例都收集 console / pageerror / 网络错误，要求为空。

---

## 10. M2：模型接在哪

只有一个地方要动：

```ts
// server/agents/types.ts
export interface AgentRun {
  run(input: RunAgentInput, signal?: AbortSignal): AsyncIterable<AnyEvent>;
}
```

M1 是 `ScriptedAgent`。M2 加一个 `LlmAgent` 实现同一个接口即可：

```
脚本化:  用户消息 → (规则) ─┐
                            ├→ ChartPlan → [DSL → 分片成 TOOL_CALL_ARGS + 文本叙述 → 事件序列]
LLM:     用户消息 → (模型) ─┘
```

方括号里那一段（`dsl-to-events.ts`）**两个实现共享**。M2 真正新增的只有
"把自然语言变成 `ChartPlan`"，下游一行不动。

`server/index.ts` 里换实现只动一行：

```ts
const agent: AgentRun = process.env.LLM_API_KEY
  ? new LlmAgent(...)
  : new ScriptedAgent(pace);   // 没有 key 就退回脚本化——clone 下来不看文档也能跑
```

**M2 可以直接吃现成的东西**：`ice-chart-dsl` 里已经有
`skills/ice-chart-dsl/SKILL.md` 和 `prompts/agent-prompt.md`，那是给模型的输出契约。

另外，M2 时 API key 必须在 Node 侧（不能进浏览器）——当前架构已经是对的。

---

## 11. 上游缺口

见 [`docs/upstream-gaps.md`](docs/upstream-gaps.md)。

一句话结论：**这个工程全程没有改过任何一个上游仓库**。作为一次对 ICE 家族对外接口的
真实集成测试，结果是接口够用——三条"绕过"都是"选择不那样用"，而不是"缺东西"。
唯一一条真正的请求是 `ChartEventName` 缺 `mark:drag` / `mark:dragend`
（类型层面的补全，不影响运行时）。

---

## 12. 许可

MIT
