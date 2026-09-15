/**
 * **这个工程的中间那层，也是 M1 和 M2 真正共享的部分。**
 *
 * 输入是一份"图表计划"（要画什么 DSL + 分几拍解说），输出是一串 AG-UI 事件。
 * 它完全不知道 DSL 是谁产出的——脚本化的规则也好、真模型也好，进来都是这个东西。
 *
 * 所以 M2 接 LLM 时，唯一新增的代码是"把自然语言变成 ChartPlan"，
 * 下面这一整段（事件顺序、文本分片、tool call 参数分片、状态同步、叙事事件）原样复用。
 *
 * 它是**纯函数**：延迟、网络、SSE 都不在这里。这样事件序列本身可以被单测穷举断言，
 * 而"每两条事件之间停 40ms"这种播放节奏留给传输层。
 */
import { EventType } from '@ag-ui/core';
import { EVT_POINT_AT, RENDER_CHART_TOOL } from '../../shared/contract';

/** 事件在这里是"开放结构 + 必有 type"。字段名的正确性由 tests/ 里的官方 schema 校验兜底。 */
export type AnyEvent = { type: EventType } & Record<string, any>;

export { EVT_POINT_AT, RENDER_CHART_TOOL };

/** 一拍解说。文案播完之后可以顺带做一件事（指一个点 / 追加一批数据）。 */
export interface ChartBeat {
  /** 这一拍的解说文字，会被分片成 TEXT_MESSAGE_CONTENT。 */
  text: string;
  /** 这一拍播完后，让客户端把高亮点移到这个 x 值上。 */
  pointAt?: string | number;
  /** 这一拍播完后，像流式数据那样往表里追加行（走标准的 JSON Patch）。 */
  appendRows?: any[][];
}

export interface ChartPlan {
  /** ice-chart-dsl 文档。不给就是纯文字回复，不发 tool call。 */
  dsl?: unknown;
  /** 开画之前说的一句。可以有。 */
  intro?: string;
  /** 画完之后的解说。这时画布已经在了，"指着讲"才有对象。 */
  beats: ChartBeat[];
  /** 分片粒度。默认值是按"人眼能看出在拼"调的；测试里会调大。 */
  textChunk?: number;
  argsChunk?: number;
}

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
 * ChartPlan → AG-UI 事件序列。
 *
 * 顺序是**先画后讲**，这一点是冒烟时改过来的：
 *
 *   RUN_STARTED
 *   [intro]  一句话说明要干什么            ← TEXT_MESSAGE_START/CONTENT/END
 *   TOOL_CALL_START ─ ARGS×n ─ END        ← 参数流式分片，前端能看到 DSL 在拼
 *   TOOL_CALL_RESULT
 *   STATE_SNAPSHOT                        ← 画布真相（可序列化、可恢复）
 *   [beats]  画完之后的解说                ← 每拍之间可插 CUSTOM 指点 / STATE_DELTA 追加
 *   RUN_FINISHED
 *
 * 为什么不是"边说边画"：`CUSTOM` 指点的对象是画布，画布得先在。
 * 第一版把解说全排在 tool call 前面，结果指点事件到达时图上什么都没有——
 * 前端只能缓冲，而缓冲意味着"指着讲"和文字不再同步，整个演示效果就没了。
 */
export function planToEvents(plan: ChartPlan, ctx: PlanContext): AnyEvent[] {
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

  if (plan.dsl !== undefined) {
    const toolCallId = id('tc');
    // 工具调用的参数**分片流式**发。这是 AG-UI 相对"工具跑完直接给结果"的差别：
    // 前端在参数还在传的时候就能显示"正在拼什么"，而不是只能转个圈。
    const payload = JSON.stringify(plan.dsl);
    push({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName: RENDER_CHART_TOOL });
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
    push({ type: EventType.STATE_SNAPSHOT, snapshot: { chart: plan.dsl } });
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
      push({ type: EventType.CUSTOM, name: EVT_POINT_AT, value: { value: beat.pointAt } });
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

  push({ type: EventType.RUN_FINISHED, threadId: ctx.threadId, runId: ctx.runId });
  return events;
}
