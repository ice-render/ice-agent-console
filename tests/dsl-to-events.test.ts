/**
 * ToolCardPlan → 事件序列。
 *
 * 这个文件里最重要的不是"顺序对不对"，而是 **`每一位事件都能被官方 schema 解析通过`**。
 *
 * 自己手写 EventType 字符串和字段名，最容易出的错是拼错一个字段（`messageId` 写成 `msgId`）
 * 或者漏一个必填字段。这类错在运行时表现为"事件发出去了但前端没反应"，
 * 而且往往只在某一条分支上出现。用官方 schema 当断言，等于把"我们发的是合规的 AG-UI 事件"
 * 变成了一条会红的测试。
 *
 * 同一份实现同时服务**图表卡与表单卡**，所以这里两类都测。
 */
import * as core from '@ag-ui/core';
import { EventType } from '@ag-ui/core';
import { chunkString, planToEvents, type ToolCardPlan, type ToolCallCardPlan,
  EVT_ZOOM,
} from '../server/agents/dsl-to-events';
import {
  COLLECT_INPUT_TOOL,
  EVT_POINT_AT,
  RENDER_CHART_TOOL,
  STATE_CHART_KEY,
  STATE_FORM_KEY,
} from '../shared/contract';

const SCHEMAS: Record<string, any> = {
  [EventType.RUN_STARTED]: core.RunStartedEventSchema,
  [EventType.RUN_FINISHED]: core.RunFinishedEventSchema,
  [EventType.RUN_ERROR]: core.RunErrorEventSchema,
  [EventType.TEXT_MESSAGE_START]: core.TextMessageStartEventSchema,
  [EventType.TEXT_MESSAGE_CONTENT]: core.TextMessageContentEventSchema,
  [EventType.TEXT_MESSAGE_END]: core.TextMessageEndEventSchema,
  [EventType.TOOL_CALL_START]: core.ToolCallStartEventSchema,
  [EventType.TOOL_CALL_ARGS]: core.ToolCallArgsEventSchema,
  [EventType.TOOL_CALL_END]: core.ToolCallEndEventSchema,
  [EventType.TOOL_CALL_RESULT]: core.ToolCallResultEventSchema,
  [EventType.STATE_SNAPSHOT]: core.StateSnapshotEventSchema,
  [EventType.STATE_DELTA]: core.StateDeltaEventSchema,
  [EventType.CUSTOM]: core.CustomEventSchema,
};

const DSL = {
  schemaVersion: 1,
  kind: 'bar',
  data: { columns: ['月份', '销量'], rows: [['1月', 120]] },
  encoding: { x: '月份', y: '销量' },
};

const FORM_DSL = {
  schemaVersion: 1,
  kind: 'form',
  title: '确认',
  fields: [{ name: 'a', type: 'text', label: '甲', required: true }],
};

const CTX = { threadId: 't1', runId: 'r1', now: () => 1_700_000_000_000, id: (p: string) => `${p}_fixed` };

/** 图表卡：补齐 tool / payload / stateKey 三个固定件。 */
function chartPlan(
  rest: Omit<ToolCallCardPlan, 'tool' | 'payload' | 'stateKey'> & { dsl?: unknown }
): ToolCallCardPlan {
  const { dsl, ...other } = rest as any;
  return { tool: RENDER_CHART_TOOL, payload: dsl === undefined ? DSL : dsl, stateKey: STATE_CHART_KEY, ...other };
}

/** 表单卡。 */
function formPlan(rest: Omit<ToolCallCardPlan, 'tool' | 'payload' | 'stateKey'>): ToolCallCardPlan {
  return { tool: COLLECT_INPUT_TOOL, payload: FORM_DSL, stateKey: STATE_FORM_KEY, ...rest };
}

function types(plan: ToolCardPlan): EventType[] {
  return planToEvents(plan, CTX).map((e) => e.type as EventType);
}

/** 断言一整串事件都过官方 schema，失败时报出是哪一条。 */
function expectAllValid(events: ReturnType<typeof planToEvents>): void {
  for (const event of events) {
    const schema = SCHEMAS[event.type];
    expect(schema).toBeDefined();
    const result = schema.safeParse(event);
    if (!result.success) {
      throw new Error(
        `${event.type} 不合规：${JSON.stringify(result.error.issues)}\n事件：${JSON.stringify(event)}`
      );
    }
  }
}

describe('事件合规性（官方 schema）', () => {
  it('图表计划里每一种事件都能通过官方 schema', () => {
    const plan = chartPlan({
      intro: '开始',
      beats: [{ text: '说一句', pointAt: '3月' }, { text: '再追加', appendRows: [[2, 20]] }],
    });
    const events = planToEvents(plan, CTX);
    expect(events.length).toBeGreaterThan(10);
    expectAllValid(events);
  });

  it('**表单计划**里每一种事件同样能通过官方 schema（含中断 outcome）', () => {
    const plan = formPlan({
      intro: '要几项参数',
      beats: [{ text: '填一下' }],
      interrupt: { id: 'i1', reason: '需要用户确认参数', message: '请确认参数' },
    });
    expectAllValid(planToEvents(plan, CTX));
  });

  it('纯文字计划也全部合规', () => {
    expectAllValid(planToEvents({ beats: [{ text: '只有文字' }] }, CTX));
  });
});

describe('事件顺序（先画后讲）', () => {
  it('STATE_SNAPSHOT 出现在所有解说之前', () => {
    // 这是冒烟时改过来的：`CUSTOM` 指点的对象是画布，画布得先在。
    // 第一版把解说全排在 tool call 前面，结果指点事件到达时图上什么都没有。
    const seq = types(chartPlan({ intro: '要画了', beats: [{ text: '画完了', pointAt: '3月' }] }));
    const snapshotAt = seq.indexOf(EventType.STATE_SNAPSHOT);
    const pointAtAt = seq.indexOf(EventType.CUSTOM);
    expect(snapshotAt).toBeGreaterThan(-1);
    expect(pointAtAt).toBeGreaterThan(snapshotAt);
  });

  it('intro 在 tool call 之前，beats 在 STATE_SNAPSHOT 之后', () => {
    const seq = types(chartPlan({ intro: '开场', beats: [{ text: '解说' }] }));
    const firstToolAt = seq.indexOf(EventType.TOOL_CALL_START);
    const snapshotAt = seq.indexOf(EventType.STATE_SNAPSHOT);
    const introEndAt = seq.indexOf(EventType.TEXT_MESSAGE_END);
    expect(introEndAt).toBeLessThan(firstToolAt);
    expect(seq.lastIndexOf(EventType.TEXT_MESSAGE_START)).toBeGreaterThan(snapshotAt);
  });

  it('以 RUN_STARTED 开头、RUN_FINISHED 结尾', () => {
    const seq = types(chartPlan({ beats: [{ text: 'x' }] }));
    expect(seq[0]).toBe(EventType.RUN_STARTED);
    expect(seq[seq.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it('没有 payload 时不发 tool call / snapshot', () => {
    const seq = types({ beats: [{ text: '只有文字' }] });
    expect(seq).not.toContain(EventType.TOOL_CALL_START);
    expect(seq).not.toContain(EventType.STATE_SNAPSHOT);
    expect(seq).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
  });

  it('每拍解说是一条独立消息（各自 START/END 配对）', () => {
    const seq = types(chartPlan({ beats: [{ text: 'A' }, { text: 'B' }] }));
    expect(seq.filter((t) => t === EventType.TEXT_MESSAGE_START)).toHaveLength(2);
    expect(seq.filter((t) => t === EventType.TEXT_MESSAGE_END)).toHaveLength(2);
  });
});

describe('中断（人机回环）', () => {
  it('有 interrupt 时 RUN_FINISHED 带 outcome', () => {
    const events = planToEvents(formPlan({ beats: [{ text: '填一下' }], interrupt: { id: 'i1', reason: '需要参数' } }), CTX);
    const finished = events[events.length - 1];
    expect(finished.type).toBe(EventType.RUN_FINISHED);
    expect(finished.outcome).toEqual({ type: 'interrupt', interrupts: [{ id: 'i1', reason: '需要参数' }] });
  });

  it('message 可选，给了就带上', () => {
    const events = planToEvents(
      formPlan({ beats: [], interrupt: { id: 'i1', reason: '原因', message: '给人看的一句' } }),
      CTX
    );
    expect(events[events.length - 1].outcome.interrupts[0]).toEqual({
      id: 'i1',
      reason: '原因',
      message: '给人看的一句',
    });
  });

  it('没有 interrupt 时不带 outcome（普通结束）', () => {
    const events = planToEvents(chartPlan({ beats: [] }), CTX);
    expect(events[events.length - 1].outcome).toBeUndefined();
  });

  it('表单卡的 STATE_SNAPSHOT 用 form 键，图表卡用 chart 键', () => {
    const formSnapshot = planToEvents(formPlan({ beats: [] }), CTX).find((e) => e.type === EventType.STATE_SNAPSHOT);
    expect(Object.keys(formSnapshot!.snapshot)).toEqual(['form']);

    const chartSnapshot = planToEvents(chartPlan({ beats: [] }), CTX).find((e) => e.type === EventType.STATE_SNAPSHOT);
    expect(Object.keys(chartSnapshot!.snapshot)).toEqual(['chart']);
  });

  it('工具名按计划走（图表 / 表单）', () => {
    const chartEvents = planToEvents(chartPlan({ beats: [] }), CTX);
    expect(chartEvents.find((e) => e.type === EventType.TOOL_CALL_START)!.toolCallName).toBe(RENDER_CHART_TOOL);

    const formEvents = planToEvents(formPlan({ beats: [] }), CTX);
    expect(formEvents.find((e) => e.type === EventType.TOOL_CALL_START)!.toolCallName).toBe(COLLECT_INPUT_TOOL);
  });
});

describe('参数分片', () => {
  it('tool call 参数是流式分片的，拼起来等于原始 JSON', () => {
    const events = planToEvents(chartPlan({ beats: [], argsChunk: 10 }), CTX);
    const args = events.filter((e) => e.type === EventType.TOOL_CALL_ARGS);
    expect(args.length).toBeGreaterThan(1);
    expect(args.map((e) => e.delta).join('')).toBe(JSON.stringify(DSL));
  });

  it('分片大小受 argsChunk 控制', () => {
    const big = planToEvents(chartPlan({ beats: [], argsChunk: 1000 }), CTX).filter(
      (e) => e.type === EventType.TOOL_CALL_ARGS
    );
    expect(big).toHaveLength(1);
  });

  it('文本空串不发 delta（协议要求 delta 非空）', () => {
    expect(chunkString('', 5)).toEqual([]);
  });

  it('chunkString 切分正确', () => {
    expect(chunkString('abcdefg', 3)).toEqual(['abc', 'def', 'g']);
    expect(chunkString('ab', 10)).toEqual(['ab']);
  });
});

describe('增量补丁', () => {
  it('appendRows 生成标准的 JSON Patch，打在 data.rows 末尾', () => {
    const events = planToEvents(chartPlan({ beats: [{ text: 'x', appendRows: [[2, 20], [3, 30]] }] }), CTX);
    const delta = events.find((e) => e.type === EventType.STATE_DELTA);
    expect(delta.delta).toEqual([
      { op: 'add', path: '/chart/data/rows/-', value: [2, 20] },
      { op: 'add', path: '/chart/data/rows/-', value: [3, 30] },
    ]);
  });

  it('指点事件用的是约定的 CUSTOM 名字', () => {
    const events = planToEvents(chartPlan({ beats: [{ text: 'x', pointAt: '3月' }] }), CTX);
    const custom = events.find((e) => e.type === EventType.CUSTOM);
    expect(custom.name).toBe(EVT_POINT_AT);
    expect(custom.value).toEqual({ value: '3月' });
  });

  it('blink 与 pointAt 打在**同一条**事件上（拆成两条会闪一帧）', () => {
    const events = planToEvents(chartPlan({ beats: [{ text: 'x', pointAt: 'ana', blink: true }] }), CTX);
    const customs = events.filter((e) => e.type === EventType.CUSTOM);
    // 这一拍只应产出一条 CUSTOM
    expect(customs).toHaveLength(1);
    expect(customs[0].name).toBe(EVT_POINT_AT);
    expect(customs[0].value).toEqual({ value: 'ana', blink: true });
  });

  it('不闪时不带 blink 字段（保持载荷最小、也便于断言"没闪"）', () => {
    const events = planToEvents(chartPlan({ beats: [{ text: 'x', pointAt: 'ana' }] }), CTX);
    const custom = events.find((e) => e.type === EventType.CUSTOM);
    expect(custom.value).toEqual({ value: 'ana' });
    expect('blink' in custom.value).toBe(false);
  });

  it('缩放事件用约定的 CUSTOM 名字，且只带显式给的字段', () => {
    const events = planToEvents(chartPlan({ beats: [{ text: 'x', zoom: { direction: 'in' } }] }), CTX);
    const custom = events.find((e) => e.type === EventType.CUSTOM);
    expect(custom.name).toBe(EVT_ZOOM);
    // 没给 factor / steps 就不编一个进去 —— 默认值是客户端的决定，服务端不替它定
    expect(custom.value).toEqual({ direction: 'in' });
  });

  it('缩放事件带 factor / steps 时原样透传', () => {
    const events = planToEvents(
      chartPlan({ beats: [{ text: 'x', zoom: { direction: 'out', factor: 1.5, steps: 2 } }] }),
      CTX
    );
    const custom = events.find((e) => e.type === EventType.CUSTOM);
    expect(custom.value).toEqual({ direction: 'out', factor: 1.5, steps: 2 });
  });

  it('缩放与指点可以在同一拍里连着发生（先指过去、再放大看）', () => {
    const events = planToEvents(
      chartPlan({ beats: [{ text: 'x', pointAt: 'ana', blink: true, zoom: { direction: 'in' } }] }),
      CTX
    );
    const customs = events.filter((e) => e.type === EventType.CUSTOM);
    expect(customs.map((e) => e.name)).toEqual([EVT_POINT_AT, EVT_ZOOM]);
  });

  it('reset 是合法的缩放方向（回到初始视野）', () => {
    const events = planToEvents(chartPlan({ beats: [{ text: 'x', zoom: { direction: 'reset' } }] }), CTX);
    const custom = events.find((e) => e.type === EventType.CUSTOM);
    expect(custom.value.direction).toBe('reset');
  });
});

describe('确定性', () => {
  it('注入了 now / id 之后，两次生成完全一致', () => {
    const plan = chartPlan({ intro: 'a', beats: [{ text: 'b', pointAt: '3月' }] });
    expect(planToEvents(plan, CTX)).toEqual(planToEvents(plan, CTX));
  });

  it('不同 run 的 id 不会撞（撞了前端会拿第二轮顶掉第一轮）', () => {
    const plan = chartPlan({ intro: 'a', beats: [{ text: 'b' }] });
    const first = planToEvents(plan, { threadId: 't1', runId: 'run_1' });
    const second = planToEvents(plan, { threadId: 't1', runId: 'run_2' });

    const idsOf = (events: typeof first) =>
      events.map((e) => e.messageId ?? e.toolCallId).filter(Boolean) as string[];
    const a = idsOf(first);
    const b = idsOf(second);

    expect(a.length).toBeGreaterThan(0);
    expect(a.some((id) => b.includes(id))).toBe(false);
  });

  it('同一个 runId 下的 id 仍然可复现', () => {
    const plan = chartPlan({ beats: [{ text: 'x' }] });
    const idsOf = (events: ReturnType<typeof planToEvents>) =>
      events.map((e) => e.messageId ?? e.toolCallId).filter(Boolean);
    expect(idsOf(planToEvents(plan, { threadId: 't1', runId: 'run_1' }))).toEqual(
      idsOf(planToEvents(plan, { threadId: 't1', runId: 'run_1' }))
    );
  });
});
