/**
 * **这个工程的中间那层，也是 M1 和 M2 真正共享的部分。**
 *
 * 输入是一份"工具卡计划"（哪个工具、流式参数是什么、分几拍解说），输出是一串 AG-UI 事件。
 * 它完全不知道参数是谁产出的——脚本化的规则也好、真模型也好，进来都是这个东西。
 *
 * 所以 M2 接 LLM 时，唯一新增的代码是"把自然语言变成 ToolCardPlan"，
 * 下面这一整段（事件顺序、文本分片、tool call 参数分片、状态同步、叙事事件、中断）
 * 原样复用。
 *
 * **图表与表单共用这一份实现**：加一种卡片在服务端只是换个 `tool` 名与 `stateKey`，
 * 事件序列的骨架完全一样。这也是"一张卡片 = 一次 tool call"在服务端的对应物。
 *
 * 它是**纯函数**：延迟、网络、SSE 都不在这里。这样事件序列本身可以被单测穷举断言，
 * 而"每两条事件之间停 40ms"这种播放节奏留给传输层。
 */
import { EventType } from '@ag-ui/core';
import { EVT_POINT_AT, EVT_ZOOM, type ZoomDirection } from '../../shared/contract';

/** 事件在这里是"开放结构 + 必有 type"。字段名的正确性由 tests/ 里的官方 schema 校验兜底。 */
export type AnyEvent = { type: EventType } & Record<string, any>;

export { EVT_POINT_AT, EVT_ZOOM };

/**
 * 缩放视图的指令。
 *
 * - `in` / `out` —— 相对当前倍率叠（`factor` / `steps`）；
 * - `reset` —— 回到初始视野；
 * - `to` —— **绝对**倍率（`scale`），讲解脚本用它（幂等，不累积）；
 * - `fit` —— **整图适配**：把全部图元框进可视区（倍率与平移一起算）。
 *
 * 详细取舍见 `shared/contract.ts` 的 `EVT_ZOOM`（方向取值也在那里，
 * `ZoomDirection` 是协议的一部分，别在本文件另抄一份字面量联合）。
 */
export interface ZoomCommand {
  direction: ZoomDirection;
  /** 每一"步"的倍率，默认 1.35。仅 `in` / `out` 用。 */
  factor?: number;
  /** 连走几步，默认 1。仅 `in` / `out` 用。 */
  steps?: number;
  /** 目标绝对倍率。仅 `to` 用，必填。 */
  scale?: number;
}

/** 一拍解说。文案播完之后可以顺带做一件事（指一个点 / 追加一批数据 / 缩放视图）。 */
export interface ChartBeat {
  /** 这一拍的解说文字，会被分片成 TEXT_MESSAGE_CONTENT。 */
  text: string;
  /** 这一拍播完后，让客户端把高亮点移到这个 x 值上。 */
  pointAt?: string | number;
  /**
   * 配合 `pointAt`：高亮之后**再闪一下**（引注意）。
   *
   * 单独一个字段而不是另开一个 `blinkAt`：闪烁的前提是"已经定位到某处"，
   * 分开写会出现"闪一个没被指到的东西"这种自相矛盾的组合。
   */
  blink?: boolean;
  /**
   * 这一拍播完后，缩放视图。
   *
   * ⚠️ 顺序：`pointAt` 先于 `zoom` 发出，而缩放锚点是**可视区中心** ——
   * 于是"先指着讲把目标移到中心、再缩放"正好把目标留在原地。
   * 反过来（先缩放再指）也对，但那样中间会有一帧目标在屏幕外。所以别调换这两行的顺序。
   */
  zoom?: ZoomCommand;
  /** 这一拍播完后，像流式数据那样往表里追加行（走标准的 JSON Patch）。 */
  appendRows?: any[][];
  /**
   * 这一拍播完后，**增删工艺图上的图元**（同样走标准的 JSON Patch）。
   *
   * 载荷就是**原样的 JSON Patch 操作数组** —— 这里不自造格式，因为
   * "state 变了"这件事协议里已经有词了（`STATE_DELTA` + RFC 6902），
   * 再发明一个"图元增删事件"只会多一条要维护的通道。
   *
   * ⚠️ `remove` 的 path 是**下标**（`/diagram/units/6`），所以拼补丁的人
   * 必须知道被删元素当前的第几位。`scenarios.ts` 里用的是
   * `indexOfUnit(dsl, id)` —— 别写死数字，那张图的单元顺序会变。
   */
  patchState?: Array<{ op: string; path: string; value?: any }>;
}

/** 一次中断：`RUN_FINISHED` 会带上它，前端据此进入"等用户答复"的状态。 */
export interface PlanInterrupt {
  id: string;
  /** 为什么中断 —— 协议必填。 */
  reason: string;
  /** 给人看的一句话（可选）。 */
  message?: string;
}

/** 两种计划共有的部分。 */
interface PlanCommon {
  /** 开画之前说的一句。可以有。 */
  intro?: string;
  /** 画完之后的解说。这时画布已经在了，"指着讲"才有对象。 */
  beats: ChartBeat[];
  /** 给了就以此**中断收尾**：`RUN_FINISHED` 带 `outcome.type === 'interrupt'`。 */
  interrupt?: PlanInterrupt;
  /** 分片粒度。默认值是按"人眼能看出在拼"调的；测试里会调大。 */
  textChunk?: number;
  argsChunk?: number;
}

/** 一次 tool call 卡片。 */
export interface ToolCallCardPlan extends PlanCommon {
  /** 工具名。**前端按它决定渲染成哪种卡片**，服务端不管渲染。 */
  tool: string;
  /** 流式分片发出去的参数（会被 `JSON.stringify`）。 */
  payload: unknown;
  /** 把它同步进共享状态的哪个键 —— agent 下一轮靠 `state` 读回"画面上现在是什么"。 */
  stateKey: string;
}

/**
 * 纯文字回复：不发 tool call、不写共享状态。
 *
 * 单独一个成员而不是把上面三个字段设成可选，是为了让"有没有 tool call"这件事在类型上就是
 * 穷尽的 —— `planToEvents` 里 `plan.payload !== undefined` 一收窄，
 * TypeScript 就知道 `tool` 与 `stateKey` 一定在，不用写 `!`。
 */
export interface TextOnlyCardPlan extends PlanCommon {
  tool?: undefined;
  payload?: undefined;
  stateKey?: undefined;
}

/** 一次 tool call 卡片的事件序列骨架。图表与表单共用。 */
export type ToolCardPlan = ToolCallCardPlan | TextOnlyCardPlan;

export interface PlanContext {
  threadId: string;
  runId: string;
  /** 每条事件的 timestamp 来源。测试里注入固定值，避免断言被时间戳打断。 */
  now?: () => number;
  /** id 生成器。测试里注入计数器，让断言可复现。 */
  id?: (prefix: string) => string;
}

/** 把字符串切成等长片段。空串返回空数组（不发空 delta，协议要求 delta 非空）。 */
export function chunkString(input: string, size: number): string[] {
  if (!input) return [];
  const step = Math.max(1, Math.floor(size));
  const out: string[] = [];
  for (let i = 0; i < input.length; i += step) {
    out.push(input.slice(i, i + step));
  }
  return out;
}

/**
 * ToolCardPlan → AG-UI 事件序列。
 *
 * 顺序是**先画后讲**，这一点是冒烟时改过来的：
 *
 *   RUN_STARTED
 *   [intro]  一句话说明要干什么            ← TEXT_MESSAGE_START/CONTENT/END
 *   TOOL_CALL_START ─ ARGS×n ─ END        ← 参数流式分片，前端能看到 DSL 在拼
 *   TOOL_CALL_RESULT
 *   STATE_SNAPSHOT                        ← 画布真相（可序列化、可恢复）
 *   [beats]  画完之后的解说                ← 每拍之间可插 CUSTOM 指点 / STATE_DELTA（追加行或增删图元）
 *   RUN_FINISHED                          ← 有 interrupt 时带 outcome
 *
 * 为什么不是"边说边画"：`CUSTOM` 指点的对象是画布，画布得先在。
 * 第一版把解说全排在 tool call 前面，结果指点事件到达时图上什么都没有——
 * 前端只能缓冲，而缓冲意味着"指着讲"和文字不再同步，整个演示效果就没了。
 */
export function planToEvents(plan: ToolCardPlan, ctx: PlanContext): AnyEvent[] {
  const now = ctx.now ?? (() => Date.now());
  let seq = 0;
  // id 里必须带 runId。第一版是 `msg_${seq}`，每轮从 0 重新数——
  // 于是第二轮又发出 `msg_0` / `tc_1`，跟第一轮撞了。前端按 id 复用 DOM 元素，
  // 撞 id 的后果是**第二轮的卡片顶掉第一轮的**，而这一点在单轮测试里根本看不出来。
  // 带上 runId 之后同一个 runId 仍然完全确定（可测），跨轮则天然唯一。
  const id = ctx.id ?? ((prefix: string) => `${prefix}_${ctx.runId}_${(seq++).toString(36)}`);
  const events: AnyEvent[] = [];
  const push = (event: AnyEvent) => events.push({ timestamp: now(), ...event });

  push({ type: EventType.RUN_STARTED, threadId: ctx.threadId, runId: ctx.runId });

  /** 发一条完整的文字消息。返回消息 id。 */
  const emitText = (text: string): string => {
    const messageId = id('msg');
    push({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' });
    for (const delta of chunkString(text, plan.textChunk ?? 6)) {
      push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta });
    }
    push({ type: EventType.TEXT_MESSAGE_END, messageId });
    return messageId;
  };

  if (plan.intro) emitText(plan.intro);

  if (plan.payload !== undefined) {
    const toolCallId = id('tc');
    // 工具调用的参数**分片流式**发。这是 AG-UI 相对"工具跑完直接给结果"的差别：
    // 前端在参数还在传的时候就能显示"正在拼什么"，而不是只能转个圈。
    const payload = JSON.stringify(plan.payload);
    push({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName: plan.tool });
    for (const delta of chunkString(payload, plan.argsChunk ?? 24)) {
      push({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta });
    }
    push({ type: EventType.TOOL_CALL_END, toolCallId });
    push({
      type: EventType.TOOL_CALL_RESULT,
      messageId: id('msg_tool'),
      toolCallId,
      role: 'tool',
      content: 'rendered',
    });
    push({ type: EventType.STATE_SNAPSHOT, snapshot: { [plan.stateKey]: plan.payload } });
  }

  // ---------- 画完之后才解说：文字与"指着讲"在同一时间线上交错 ----------
  for (const beat of plan.beats) {
    const messageId = id('msg');
    push({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' });
    for (const delta of chunkString(beat.text, plan.textChunk ?? 6)) {
      push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta });
    }
    // 解说播完的瞬间做动作——这正是"文字和图同拍"的关键：
    // 用户读到哪里，图就指到哪里。
    if (beat.pointAt !== undefined) {
      push({
        type: EventType.CUSTOM,
        name: EVT_POINT_AT,
        // blink 与 pointAt 打在**同一条**事件上而不是两条：它们是"定位到某处并强调"
        // 的一次动作，拆成两条会让客户端先高亮、再补一次闪烁，中间闪一帧。
        value: { value: beat.pointAt, ...(beat.blink ? { blink: true } : {}) },
      });
    }
    if (beat.zoom) {
      push({
        type: EventType.CUSTOM,
        name: EVT_ZOOM,
        value: {
          direction: beat.zoom.direction,
          ...(beat.zoom.factor !== undefined ? { factor: beat.zoom.factor } : {}),
          ...(beat.zoom.steps !== undefined ? { steps: beat.zoom.steps } : {}),
          ...(beat.zoom.scale !== undefined ? { scale: beat.zoom.scale } : {}),
        },
      });
    }
    if (beat.patchState && beat.patchState.length) {
      // 与 appendRows 同一条通道（`STATE_DELTA`），只是路径不同：
      // 那个往 `/chart/data/rows` 追加，这个增删 `/diagram/units` 与 `/diagram/pipes`。
      // 前端按**补丁的形状**分流（见 state-patch.ts 的两个 detect*），
      // 所以这里不需要告诉它"这是图元增删" —— 形状本身就说明了。
      push({ type: EventType.STATE_DELTA, delta: beat.patchState });
    }

    if (beat.appendRows) {
      // 标准 JSON Patch（RFC 6902）：往 DSL 的 data.rows 末尾追加。
      // 之所以打在 DSL 上而不是打在编译后的 ChartOption 上，是因为 DSL 才是
      // "画布真相"——它是可序列化、可恢复、可跨端重放的那份东西。
      //
      // 前端会认出"这批补丁只是在往 rows 末尾追加"，从而走 appendData 快路径，
      // 而不是把整张图重新编译一遍。识别规则是纯函数，见 src/domain/agui/state-patch.ts。
      push({
        type: EventType.STATE_DELTA,
        delta: beat.appendRows.map((row) => ({
          op: 'add',
          path: '/chart/data/rows/-',
          value: row,
        })),
      });
    }
    push({ type: EventType.TEXT_MESSAGE_END, messageId });
  }

  // 中断：run 仍然是"结束"，只是留了一个待答复的口子。
  // 协议规定恢复方式是**开一个新 run** 并在 `resume` 里逐条应答。
  push({
    type: EventType.RUN_FINISHED,
    threadId: ctx.threadId,
    runId: ctx.runId,
    ...(plan.interrupt
      ? {
          outcome: {
            type: 'interrupt',
            interrupts: [
              {
                id: plan.interrupt.id,
                reason: plan.interrupt.reason,
                ...(plan.interrupt.message ? { message: plan.interrupt.message } : {}),
              },
            ],
          },
        }
      : {}),
  });
  return events;
}
