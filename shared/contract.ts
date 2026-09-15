/**
 * **我们自己的扩展契约**（不是协议契约）。
 *
 * `@ag-ui/core` 管的是协议本身：事件类型、字段名、RunAgentInput 的形状。
 * 但协议留了两个开放的扩展点——`CUSTOM` 事件和 `RunAgentInput.context`——
 * 里面装什么由应用自己定。这份文件就是那些"应用自己定的名字"的唯一出处。
 *
 * 为什么要单独一个目录：server 和 web 两边都要用这些名字，
 * 而它们分属两套 tsconfig（`tsconfig.server.json` 不加载 DOM、`tsconfig.json` 不加载 node）。
 * 名字写两份的后果不是编译错误，是**运行时静默不匹配**——事件发出去了没人认领。
 * 这类 bug 最难查，所以宁可多一个文件也不要复制字符串。
 *
 * 注意：这个目录**不包括**协议本身。协议类型一律从 `@ag-ui/core` 取，
 * 不要在这里再造一份事件类型定义。
 */

/** 渲染图表的工具名。前端按这个名字分发到 ICE 渲染器。 */
export const RENDER_CHART_TOOL = 'render_chart';

/**
 * 收集用户输入的工具名。参数是一份**表单 DSL**（`ice-web-components-dsl`）。
 *
 * 卡片按工具名分派：`render_chart` 出图表、`collect_input` 出表单。
 * 这就是"一张卡片 = 一次 tool call"这个粒度的好处 —— 加一种卡片只是加一个工具名，
 * 归约器与时间线完全不用动。
 */
export const COLLECT_INPUT_TOOL = 'collect_input';

/**
 * 图表 DSL 在共享状态里的键。
 *
 * AG-UI 的 `state` 是**一份两边都看得见的文档**，这里放"画布上现在是什么"。
 * 与 `form` 分开命名而不是共用 `dsl`，是为了让 agent 一眼看出当前是什么内容。
 */
export const STATE_CHART_KEY = 'chart';

/** 表单 DSL 在共享状态里的键。 */
export const STATE_FORM_KEY = 'form';

/**
 * 「指着讲」的画布指令。走 CUSTOM 事件。
 *
 * 不走 tool call：它不是一次工具执行，没有参数、没有结果。
 * 不走 state：它是瞬时的演示动作，不是需要恢复的状态。
 */
export const EVT_POINT_AT = 'ice/point-at';

/**
 * 「清掉高亮」的画布指令，同样走 CUSTOM。
 * 单独一条是因为"讲完了要收手"，跟"指到某处"是两件事。
 */
export const EVT_POINT_CLEAR = 'ice/point-clear';

/**
 * 诊断回灌的 context 键。
 *
 * 自修复回路的中间那一段：客户端用 `validateChartDsl` 校验 DSL，
 * 不通过时把结构化诊断塞进下一轮 run 的 context，agent 据此吐修正版。
 *
 * 这是 AG-UI 双向语义最实在的一处应用——协议里没有"把渲染端的错误回传给 agent"
 * 的原生通道，但 `context` 就是给这类东西准备的。
 */
export const DSL_DIAGNOSTICS_CONTEXT_KEY = 'ice-dsl-diagnostics';

/**
 * 「用户在图上做了什么」的结构化上下文。
 *
 * 这是往返回路的**上行**那一段：用户点了一个数据点、或框选了一段区间，
 * 应用把它作为结构化 context 带进下一轮 run，而不是塞进用户说的话里。
 *
 * 为什么走 context 而不是拼进文字：拼文字会让"用户说的"和"用户做的"糊在一起，
 * agent 分不清哪部分是人的原话、哪部分是程序补的。分开之后，
 * 提示词里可以给"用户动作"一个明确的地位，也便于以后换成别的协议时原样搬走。
 */
export const VIEW_INTERACTION_CONTEXT_KEY = 'ice-view-interaction';

/**
 * 用户提交表单后回传的上下文键。
 *
 * 与 `interrupt` 的 `resume.payload` 是**两回事**，别混：
 * - `resume.payload` 是协议原生的"对这次中断的答复"，走 `RunAgentInput.resume`；
 * - 这条 context 是应用层的补充说明（哪个卡片、什么场景），走 `context`。
 *
 * 之所以两者都发：`resume` 让协议层知道"这个中断被答复了"，
 * `context` 让 agent 知道"这次答复来自哪张卡片"—— 后者协议不管，但提示词里有用。
 */
export const FORM_SUBMIT_CONTEXT_KEY = 'ice-form-submit';
