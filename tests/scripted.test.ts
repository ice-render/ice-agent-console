/**
 * 脚本化 agent 与剧本选择。
 *
 * 这里的用例是 M2 的**安全网**：等 `LlmAgent` 接进来，`lastUserMessage` / `readDiagnostics`
 * 这些"读输入"的函数会被复用，而 `buildPlan` 会被替换。所以要把"读输入"的行为
 * 和"选剧本"的行为分别钉住——换掉一个的时候，另一个的红灯能告诉你哪里断了。
 */
import type { RunAgentInput } from '@ag-ui/core';
import { EventType } from '@ag-ui/core';
import { DEFAULT_PACE, NO_PACE, ScriptedAgent, lastUserMessage, readDiagnostics } from '../server/agents/scripted';
import { buildPlan } from '../server/agents/scenarios';
import { planToEvents } from '../server/agents/dsl-to-events';
import { DSL_DIAGNOSTICS_CONTEXT_KEY } from '../shared/contract';

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
        messages: [{ id: '1', role: 'user', content: [{ type: 'text', text: '分' }, { type: 'text', text: '片' }] }] as any,
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
  /**
   * `ChartPlan.dsl` 声明成 `unknown` 是故意的：M2 接模型之后，dsl 可能来自模型输出，
   * 类型上不该假装我们知道形状。测试里要断言具体字段，就显式断言一下类型。
   */
  const dsl = (plan: ReturnType<typeof buildPlan>) => plan.dsl as any;

  it('同样的说法永远选到同一个剧本（确定性是 e2e 的前提）', () => {
    expect(buildPlan('看看各渠道的月度销量', false)).toEqual(buildPlan('看看各渠道的月度销量', false));
  });

  it('销量 → 柱状图 + 指着 3 月讲', () => {
    const plan = buildPlan('看看各渠道的月度销量', false);
    expect(dsl(plan).kind).toBe('bar');
    expect(plan.beats.some((b) => b.pointAt === '3月')).toBe(true);
  });

  it('实时 → 折线 + 逐拍追加数据', () => {
    const plan = buildPlan('看一下实时吞吐量', false);
    expect(dsl(plan).kind).toBe('line');
    expect(plan.beats.filter((b) => b.appendRows).length).toBe(3);
  });

  it('故意画错 → 第一次吐的是坏 DSL（列名不存在）', () => {
    const plan = buildPlan('故意画错', false);
    expect(dsl(plan).encoding.y).toBe('销售额');
    expect(dsl(plan).data.columns).not.toContain('销售额');
  });

  it('带诊断进来 → 吐修正版，列名回到真的那一列', () => {
    const plan = buildPlan('随便说点什么', true);
    expect(dsl(plan).encoding.y).toBe('销量');
    expect(dsl(plan).data.columns).toContain('销量');
  });

  it('诊断优先于关键词：修复轮里说什么都走修复', () => {
    expect(dsl(buildPlan('看看各渠道的月度销量', true)).encoding.y).toBe('销量');
  });

  it('兜底剧本不画图', () => {
    expect(buildPlan('今天天气怎么样', false).dsl).toBeUndefined();
  });
});

describe('ScriptedAgent', () => {
  it('NO_PACE 下产出的事件序列与 planToEvents 一致', async () => {
    // 播放节奏不属于事件序列——这条断言就是在钉这个分界
    const agent = new ScriptedAgent(NO_PACE);
    const collected: any[] = [];
    const req = input({ messages: [{ id: '1', role: 'user', content: '看看各渠道的月度销量' }] as any });
    for await (const event of agent.run(req)) collected.push(event);

    const expected = planToEvents(buildPlan('看看各渠道的月度销量', false), {
      threadId: 't1',
      runId: 'r1',
    });
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
