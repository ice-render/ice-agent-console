/**
 * DSL → 事件序列。
 *
 * 这个文件里最重要的不是"顺序对不对"，而是 **`每一位事件都能被官方 schema 解析通过`**。
 *
 * 自己手写 EventType 字符串和字段名，最容易出的错是拼错一个字段（`messageId` 写成 `msgId`）
 * 或者漏一个必填字段。这类错在运行时表现为"事件发出去了但前端没反应"，
 * 而且往往只在某一条分支上出现。用官方 schema 当断言，等于把"我们发的是合规的 AG-UI 事件"
 * 变成了一条会红的测试。
 */
import * as core from '@ag-ui/core';
import { EventType } from '@ag-ui/core';
import { chunkString, planToEvents, type ChartPlan } from '../server/agents/dsl-to-events';
import { EVT_POINT_AT } from '../shared/contract';

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

const CTX = { threadId: 't1', runId: 'r1', now: () => 1_700_000_000_000, id: (p: string) => `${p}_fixed` };

function types(plan: ChartPlan): EventType[] {
  return planToEvents(plan, CTX).map((e) => e.type as EventType);
}

describe('事件合规性（官方 schema）', () => {
  it('计划里每一种事件都能通过官方 schema', () => {
    const plan: ChartPlan = {
      dsl: DSL,
      intro: '开始',
      beats: [{ text: '说一句', pointAt: '3月' }, { text: '再追加', appendRows: [[2, 20]] }],
    };
    const events = planToEvents(plan, CTX);
    expect(events.length).toBeGreaterThan(10);

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
  });

  it('纯文字计划也全部合规', () => {
    const events = planToEvents({ beats: [{ text: '只有文字' }] }, CTX);
    for (const event of events) {
      expect(SCHEMAS[event.type].safeParse(event).success).toBe(true);
    }
  });
});

describe('事件顺序（先画后讲）', () => {
  it('STATE_SNAPSHOT 出现在所有解说之前', () => {
    // 这是冒烟时改过来的：`CUSTOM` 指点的对象是画布，画布得先在。
    // 第一版把解说全排在 tool call 前面，结果指点事件到达时图上什么都没有。
    const plan: ChartPlan = {
      dsl: DSL,
      intro: '要画了',
      beats: [{ text: '画完了', pointAt: '3月' }],
    };
    const seq = types(plan);
    const snapshotAt = seq.indexOf(EventType.STATE_SNAPSHOT);
    const pointAtAt = seq.indexOf(EventType.CUSTOM);
    expect(snapshotAt).toBeGreaterThan(-1);
    expect(pointAtAt).toBeGreaterThan(snapshotAt);
  });

  it('intro 在 tool call 之前，beats 在 STATE_SNAPSHOT 之后', () => {
    const seq = types({ dsl: DSL, intro: '开场', beats: [{ text: '解说' }] });
    const firstToolAt = seq.indexOf(EventType.TOOL_CALL_START);
    const snapshotAt = seq.indexOf(EventType.STATE_SNAPSHOT);
    const introEndAt = seq.indexOf(EventType.TEXT_MESSAGE_END);
    expect(introEndAt).toBeLessThan(firstToolAt);
    // 最后一个 TEXT_MESSAGE_START 属于 beats
    expect(seq.lastIndexOf(EventType.TEXT_MESSAGE_START)).toBeGreaterThan(snapshotAt);
  });

  it('以 RUN_STARTED 开头、RUN_FINISHED 结尾', () => {
    const seq = types({ dsl: DSL, beats: [{ text: 'x' }] });
    expect(seq[0]).toBe(EventType.RUN_STARTED);
    expect(seq[seq.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it('没有 dsl 时不发 tool call / snapshot', () => {
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
    const seq = types({ dsl: DSL, beats: [{ text: 'A' }, { text: 'B' }] });
    expect(seq.filter((t) => t === EventType.TEXT_MESSAGE_START)).toHaveLength(2);
    expect(seq.filter((t) => t === EventType.TEXT_MESSAGE_END)).toHaveLength(2);
  });
});

describe('参数分片', () => {
  it('tool call 参数是流式分片的，拼起来等于原始 JSON', () => {
    const events = planToEvents({ dsl: DSL, beats: [], argsChunk: 10 }, CTX);
    const args = events.filter((e) => e.type === EventType.TOOL_CALL_ARGS);
    expect(args.length).toBeGreaterThan(1);
    expect(args.map((e) => e.delta).join('')).toBe(JSON.stringify(DSL));
  });

  it('分片大小受 argsChunk 控制', () => {
    const big = planToEvents({ dsl: DSL, beats: [], argsChunk: 1000 }, CTX).filter(
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
    const events = planToEvents({ dsl: DSL, beats: [{ text: 'x', appendRows: [[2, 20], [3, 30]] }] }, CTX);
    const delta = events.find((e) => e.type === EventType.STATE_DELTA);
    expect(delta.delta).toEqual([
      { op: 'add', path: '/chart/data/rows/-', value: [2, 20] },
      { op: 'add', path: '/chart/data/rows/-', value: [3, 30] },
    ]);
  });

  it('指点事件用的是约定的 CUSTOM 名字', () => {
    const events = planToEvents({ dsl: DSL, beats: [{ text: 'x', pointAt: '3月' }] }, CTX);
    const custom = events.find((e) => e.type === EventType.CUSTOM);
    expect(custom.name).toBe(EVT_POINT_AT);
    expect(custom.value).toEqual({ value: '3月' });
  });
});

describe('确定性', () => {
  it('注入了 now / id 之后，两次生成完全一致', () => {
    // 确定性是 e2e 和回放的前提
    const plan: ChartPlan = { dsl: DSL, intro: 'a', beats: [{ text: 'b', pointAt: '3月' }] };
    expect(planToEvents(plan, CTX)).toEqual(planToEvents(plan, CTX));
  });

  it('不同 run 的 id 不会撞（撞了前端会拿第二轮顶掉第一轮）', () => {
    const plan: ChartPlan = { dsl: DSL, intro: 'a', beats: [{ text: 'b' }] };
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
    const plan: ChartPlan = { dsl: DSL, beats: [{ text: 'x' }] };
    const idsOf = (events: ReturnType<typeof planToEvents>) =>
      events.map((e) => e.messageId ?? e.toolCallId).filter(Boolean);
    expect(idsOf(planToEvents(plan, { threadId: 't1', runId: 'run_1' }))).toEqual(
      idsOf(planToEvents(plan, { threadId: 't1', runId: 'run_1' }))
    );
  });
});
