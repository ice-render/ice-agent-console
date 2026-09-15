/**
 * 脚本化 agent、剧本选择、以及**人机回环的 resume**。
 *
 * 这里的用例是 M2 的**安全网**：等 `LlmAgent` 接进来，`lastUserMessage` / `readDiagnostics`
 * 这些"读输入"的部分会被复用，而 `buildPlan` 会被替换。所以要把"读输入"的行为
 * 和"选剧本"的行为分别钉住——换掉一个的时候，另一个的红灯能告诉你哪里断了。
 */
import type { RunAgentInput } from '@ag-ui/core';
import { EventType } from '@ag-ui/core';
import {
  DEFAULT_PACE,
  NO_PACE,
  ScriptedAgent,
  lastUserMessage,
  readDiagnostics,
} from '../server/agents/scripted';
import { buildPlan, resumeValues } from '../server/agents/scenarios';
import { planToEvents, type ToolCallCardPlan } from '../server/agents/dsl-to-events';
import { COLLECT_INPUT_TOOL, DSL_DIAGNOSTICS_CONTEXT_KEY, RENDER_CHART_TOOL } from '../shared/contract';

function input(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: 't1',
    runId: 'r1',
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides,
  } as RunAgentInput;
}

/**
 * 从计划里取工具参数。类型上"纯文字计划没有 payload"，所以这里用 `?? {}` 收窄，
 * 只在断言具体字段时才用 any。
 */
const payloadOf = (plan: ReturnType<typeof buildPlan>) => (plan.payload ?? {}) as any;
/** 计划声明的工具名（纯文字计划没有）。 */
const toolOf = (plan: ReturnType<typeof buildPlan>) => (plan as ToolCallCardPlan).tool;

describe('lastUserMessage', () => {
  it('取最后一条用户消息', () => {
    const value = lastUserMessage(
      input({
        messages: [
          { id: '1', role: 'user', content: '第一句' },
          { id: '2', role: 'assistant', content: '回答' },
          { id: '3', role: 'user', content: '第二句' },
        ] as any,
      })
    );
    expect(value).toBe('第二句');
  });

  it('content 是 parts 数组时拼出文本', () => {
    const value = lastUserMessage(
      input({
        messages: [
          { id: '1', role: 'user', content: [{ type: 'text', text: '分' }, { type: 'text', text: '片' }] },
        ] as any,
      })
    );
    expect(value).toBe('分片');
  });

  it('没有用户消息时返回空串', () => {
    expect(lastUserMessage(input())).toBe('');
  });
});

describe('readDiagnostics', () => {
  it('没有诊断时返回 null', () => {
    expect(readDiagnostics(input())).toBeNull();
  });

  it('认出约定 key 的诊断', () => {
    const value = readDiagnostics(
      input({ context: [{ description: DSL_DIAGNOSTICS_CONTEXT_KEY, value: '列不存在' }] as any })
    );
    expect(value).toBe('列不存在');
  });

  it('别的 context 条目不会误判', () => {
    const value = readDiagnostics(
      input({ context: [{ description: 'ice-view-interaction', value: '{}' }] as any })
    );
    expect(value).toBeNull();
  });

  it('value 不是字符串时序列化返回', () => {
    const value = readDiagnostics(
      input({ context: [{ description: DSL_DIAGNOSTICS_CONTEXT_KEY, value: { code: 'x' } }] as any })
    );
    expect(value).toBe('{"code":"x"}');
  });
});

describe('buildPlan 剧本选择', () => {
  it('同样的说法永远选到同一个剧本（确定性是 e2e 的前提）', () => {
    const once = buildPlan({ message: '看看各渠道的月度销量', hasDiagnostics: false });
    const twice = buildPlan({ message: '看看各渠道的月度销量', hasDiagnostics: false });
    expect(once).toEqual(twice);
  });

  it('销量 → 柱状图 + 指着 3 月讲', () => {
    const plan = buildPlan({ message: '看看各渠道的月度销量', hasDiagnostics: false });
    expect(toolOf(plan)).toBe(RENDER_CHART_TOOL);
    expect(payloadOf(plan).kind).toBe('bar');
    expect(plan.beats.some((b) => b.pointAt === '3月')).toBe(true);
  });

  it('实时 → 折线 + 逐拍追加数据', () => {
    const plan = buildPlan({ message: '看一下实时吞吐量', hasDiagnostics: false });
    expect(payloadOf(plan).kind).toBe('line');
    expect(plan.beats.filter((b) => b.appendRows).length).toBe(3);
  });

  it('故意画错 → 第一次吐的是坏 DSL（列名不存在）', () => {
    const plan = buildPlan({ message: '故意画错', hasDiagnostics: false });
    expect(payloadOf(plan).encoding.y).toBe('销售额');
    expect(payloadOf(plan).data.columns).not.toContain('销售额');
  });

  it('带诊断进来 → 吐修正版，列名回到真的那一列', () => {
    const plan = buildPlan({ message: '随便说点什么', hasDiagnostics: true });
    expect(payloadOf(plan).encoding.y).toBe('销量');
    expect(payloadOf(plan).data.columns).toContain('销量');
  });

  it('诊断优先于关键词：修复轮里说什么都走修复', () => {
    const plan = buildPlan({ message: '看看各渠道的月度销量', hasDiagnostics: true });
    expect(payloadOf(plan).encoding.y).toBe('销量');
  });

  it('兜底剧本不画图', () => {
    expect(buildPlan({ message: '今天天气怎么样', hasDiagnostics: false }).payload).toBeUndefined();
  });
});

describe('人机回环：中断与 resume', () => {
  it('「下发指令」走中断剧本：吐表单 + RUN_FINISHED 带 outcome', () => {
    const plan = buildPlan({ message: '要下发指令', hasDiagnostics: false });

    expect(toolOf(plan)).toBe(COLLECT_INPUT_TOOL);
    expect(payloadOf(plan).kind).toBe('form');
    expect(payloadOf(plan).fields.length).toBeGreaterThan(0);
    expect(plan.interrupt).toBeTruthy();
    expect(plan.interrupt!.id).toBeTruthy();
    expect(plan.interrupt!.reason).toBeTruthy();

    // 事件序列的末尾确实带上了中断
    const events = planToEvents(plan, { threadId: 't1', runId: 'r1' });
    const finished = events[events.length - 1];
    expect(finished.type).toBe(EventType.RUN_FINISHED);
    expect(finished.outcome.type).toBe('interrupt');
    expect(finished.outcome.interrupts[0].id).toBe(plan.interrupt!.id);
  });

  it('resumeValues 从协议通道里取出用户填的值', () => {
    expect(resumeValues([{ interruptId: 'i1', status: 'resolved', payload: { a: 1 } }])).toEqual({ a: 1 });
  });

  it('status=cancelled 时视为"没有答复"', () => {
    expect(resumeValues([{ interruptId: 'i1', status: 'cancelled' }])).toBeNull();
  });

  it('没有 resume / 空数组时返回 null', () => {
    expect(resumeValues(null)).toBeNull();
    expect(resumeValues(undefined)).toBeNull();
    expect(resumeValues([])).toBeNull();
  });

  it('带 resume 进来 → 应答里带上了用户填的值', () => {
    const plan = buildPlan({
      message: '（已提交表单）',
      hasDiagnostics: false,
      resume: [{ interruptId: 'confirm-params', status: 'resolved', payload: { station: '一号泵站', flow: 1200 } }],
    });

    // 应答不产生新的工具卡（这一轮是"接着往下走"，不是"再问一次"）
    expect(plan.payload).toBeUndefined();
    expect(plan.interrupt).toBeUndefined();
    const text = plan.beats.map((b) => b.text).join('\n');
    expect(text).toContain('一号泵站');
    expect(text).toContain('1200');
    expect(text).toContain('resume');
  });

  it('resume 优先于关键词：带着答复来就不会又走一遍中断剧本', () => {
    const plan = buildPlan({
      message: '要下发指令', // 这个关键词平时会触发中断
      hasDiagnostics: false,
      resume: [{ interruptId: 'confirm-params', status: 'resolved', payload: { station: 'p2' } }],
    });
    expect(plan.interrupt).toBeUndefined();
    expect(toolOf(plan)).toBeUndefined();
  });
});

describe('ScriptedAgent', () => {
  it('NO_PACE 下产出的事件序列与 planToEvents 一致', async () => {
    // 播放节奏不属于事件序列——这条断言就是在钉这个分界
    const agent = new ScriptedAgent(NO_PACE);
    const collected: any[] = [];
    const req = input({ messages: [{ id: '1', role: 'user', content: '看看各渠道的月度销量' }] as any });
    for await (const event of agent.run(req)) collected.push(event);

    const expected = planToEvents(
      buildPlan({ message: '看看各渠道的月度销量', hasDiagnostics: false }),
      { threadId: 't1', runId: 'r1' }
    );
    expect(collected.map((e) => e.type)).toEqual(expected.map((e) => e.type));
  });

  it('带诊断的输入会得到修复版（列名对得上）', async () => {
    const agent = new ScriptedAgent(NO_PACE);
    const req = input({
      messages: [{ id: '1', role: 'user', content: '继续' }] as any,
      context: [{ description: DSL_DIAGNOSTICS_CONTEXT_KEY, value: '列「销售额」不存在' }] as any,
    });
    const collected: any[] = [];
    for await (const event of agent.run(req)) collected.push(event);

    const args = collected
      .filter((e) => e.type === EventType.TOOL_CALL_ARGS)
      .map((e) => e.delta)
      .join('');
    expect(JSON.parse(args).encoding.y).toBe('销量');
  });

  it('**带 resume 的输入**：agent 读得到用户填的值', async () => {
    const agent = new ScriptedAgent(NO_PACE);
    const req = input({
      messages: [{ id: '1', role: 'user', content: '（已提交表单）' }] as any,
      resume: [
        { interruptId: 'confirm-params', status: 'resolved', payload: { station: '一号泵站', flow: 1200 } },
      ] as any,
    });
    const collected: any[] = [];
    for await (const event of agent.run(req)) collected.push(event);

    const text = collected
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => e.delta)
      .join('');
    expect(text).toContain('一号泵站');
    expect(text).toContain('1200');
    // 这一轮不产生新的工具卡
    expect(collected.some((e) => e.type === EventType.TOOL_CALL_START)).toBe(false);
    // 也不带中断（这是一次普通结束）
    expect(collected[collected.length - 1].outcome).toBeUndefined();
  });

  it('中断剧本最后一条事件带 outcome', async () => {
    const agent = new ScriptedAgent(NO_PACE);
    const req = input({ messages: [{ id: '1', role: 'user', content: '要下发指令' }] as any });
    const collected: any[] = [];
    for await (const event of agent.run(req)) collected.push(event);

    const last = collected[collected.length - 1];
    expect(last.type).toBe(EventType.RUN_FINISHED);
    expect(last.outcome.type).toBe('interrupt');
  });

  it('abort 之后立刻停止产出', async () => {
    const agent = new ScriptedAgent(DEFAULT_PACE);
    const controller = new AbortController();
    const req = input({ messages: [{ id: '1', role: 'user', content: '看看销量' }] as any });

    const collected: any[] = [];
    for await (const event of agent.run(req, controller.signal)) {
      collected.push(event);
      if (collected.length === 2) controller.abort();
    }
    // 取消后不应该把整条 run 跑完
    expect(collected.length).toBeLessThan(39);
  });
});
