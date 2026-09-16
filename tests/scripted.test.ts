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
  readDiagnosticsTool,
} from '../server/agents/scripted';
import { buildPlan, resumeValues } from '../server/agents/scenarios';
import { planToEvents, type ToolCallCardPlan } from '../server/agents/dsl-to-events';
import {
  COLLECT_INPUT_TOOL,
  DSL_DIAGNOSTICS_CONTEXT_KEY,
  DSL_TOOL_CONTEXT_KEY,
  RENDER_CHART_TOOL,
  RENDER_DIAGRAM_TOOL,
  STATE_DIAGRAM_KEY,
} from '../shared/contract';

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

describe('图卡剧本（内置案例：污水处理工艺图）', () => {
  it('水务问法 → 图卡，而不是图表卡', () => {
    const plan = buildPlan({ message: '看看污水处理工艺图', hasDiagnostics: false });
    expect(toolOf(plan)).toBe(RENDER_DIAGRAM_TOOL);
    expect((plan as ToolCallCardPlan).stateKey).toBe(STATE_DIAGRAM_KEY);
  });

  it('载荷是 34 个单元 / 37 段管线（与 ice-smart-water 的案例一致）', () => {
    const plan = buildPlan({ message: '看看污水处理工艺图', hasDiagnostics: false }) as ToolCallCardPlan;
    const payload = payloadOf(plan);
    expect(payload.kind).toBe('water-process');
    expect(payload.units).toHaveLength(34);
    expect(payload.pipes).toHaveLength(37);
  });

  it('★ 含「流」的水务问法不会被流式剧本抢走', () => {
    // 回归：水务分支必须排在 `/实时|趋势|流|…/` **之前**，
    // 否则"工艺流程"里的"流"会把这条问法判成实时吞吐量
    for (const text of ['看看工艺流程', '污水处理工艺流程', 'AAO 工艺流程图']) {
      const plan = buildPlan({ message: text, hasDiagnostics: false });
      expect(toolOf(plan)).toBe(RENDER_DIAGRAM_TOOL);
    }
    // 反向：真的问吞吐量还是要走流式剧本
    const streaming = buildPlan({ message: '看一下实时吞吐量', hasDiagnostics: false });
    expect(toolOf(streaming)).toBe(RENDER_CHART_TOOL);
  });

  it('节拍里有指着讲的单元 id，且都能在图里找到', () => {
    const plan = buildPlan({ message: '看看污水处理工艺图', hasDiagnostics: false }) as ToolCallCardPlan;
    const ids = new Set(payloadOf(plan).units.map((u: any) => u.id));
    const pointed = (plan.beats || []).map((b) => b.pointAt).filter(Boolean) as string[];
    expect(pointed.length).toBeGreaterThan(0);
    for (const id of pointed) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('「故意画错工艺图」吐的是**图**的坏 DSL（未知符号种类），不是图表的坏 DSL', () => {
    const plan = buildPlan({ message: '故意画错工艺图', hasDiagnostics: false }) as ToolCallCardPlan;
    expect(toolOf(plan)).toBe(RENDER_DIAGRAM_TOOL);
    const kinds = payloadOf(plan).units.map((u: any) => u.kind);
    expect(kinds).toContain('greaseTrap'); // 隔油池：看着合理，但不在这套 31 种符号里
  });

  it('★ 修复轮按 diagnosticsTool 吐回同一种卡片（不然图 DSL 写错会被"修"成柱状图）', () => {
    const fixedDiagram = buildPlan({
      message: '',
      hasDiagnostics: true,
      diagnosticsTool: RENDER_DIAGRAM_TOOL,
    }) as ToolCallCardPlan;
    expect(toolOf(fixedDiagram)).toBe(RENDER_DIAGRAM_TOOL);
    expect((fixedDiagram as any).payload.units.map((u: any) => u.kind)).not.toContain('greaseTrap');

    // 老客户端不发这条 → 退回图表卡（与加这条之前的行为一致）
    const fallback = buildPlan({ message: '', hasDiagnostics: true }) as ToolCallCardPlan;
    expect(toolOf(fallback)).toBe(RENDER_CHART_TOOL);
  });

  it('缩放问法 → 走缩放剧本，节拍里有 zoom 指令', () => {
    const plan = buildPlan({ message: '把工艺图放大', hasDiagnostics: false }) as ToolCallCardPlan;
    expect(toolOf(plan)).toBe(RENDER_DIAGRAM_TOOL);
    const zooms = (plan.beats || []).map((b) => b.zoom).filter(Boolean);
    expect(zooms.length).toBeGreaterThan(0);
    // 必须是**相对**语义（含 reset），不是绝对倍率
    expect(zooms.some((z: any) => z.direction === 'in')).toBe(true);
    expect(zooms.some((z: any) => z.direction === 'reset')).toBe(true);
  });

  it('★ 「把工艺图放大」不能被"重画一张工艺图"抢走', () => {
    // 回归：缩放分支必须排在 isWaterAsk **之前**。
    // 排后面的话这一句会被 waterProcessPlan 收走 —— 用户要点"放大"，
    // 看到的却是一张重画的图（而且这轮根本没有 zoom 指令）。
    for (const text of ['把工艺图放大', '放大一点', '缩小', '复位', '推近看']) {
      const plan = buildPlan({ message: text, hasDiagnostics: false }) as ToolCallCardPlan;
      expect(toolOf(plan)).toBe(RENDER_DIAGRAM_TOOL);
      expect((plan.beats || []).some((b) => !!b.zoom)).toBe(true);
    }
  });

  it('缩小 / 复位也是缩放剧本', () => {
    const out = buildPlan({ message: '缩小', hasDiagnostics: false }) as ToolCallCardPlan;
    expect((out.beats || []).some((b: any) => b.zoom?.direction === 'out')).toBe(true);
  });

  it('闪烁问法 → 图卡 + 节拍里 pointAt 带 blink', () => {
    const plan = buildPlan({ message: '让图元闪烁', hasDiagnostics: false }) as ToolCallCardPlan;
    expect(toolOf(plan)).toBe(RENDER_DIAGRAM_TOOL);
    const blinked = (plan.beats || []).filter((b) => b.blink);
    expect(blinked.length).toBeGreaterThan(0);
    // 闪的必须同时有指的地方（否则就是"闪一个没被指到的东西"）
    for (const b of blinked) {
      expect(b.pointAt).toBeDefined();
    }
  });

  it('★ 「让工艺图闪烁」也要排在 isWaterAsk 之前', () => {
    for (const text of ['让图元闪烁', '工艺图闪一下', '闪一闪']) {
      const plan = buildPlan({ message: text, hasDiagnostics: false }) as ToolCallCardPlan;
      expect(toolOf(plan)).toBe(RENDER_DIAGRAM_TOOL);
      expect((plan.beats || []).some((b) => !!b.blink)).toBe(true);
    }
  });

  it('闪烁节的点都在图里存在（id 对得上）', () => {
    const plan = buildPlan({ message: '让图元闪烁', hasDiagnostics: false }) as ToolCallCardPlan;
    const ids = new Set(payloadOf(plan).units.map((u: any) => u.id));
    for (const b of plan.beats || []) {
      if (b.blink) expect(ids.has(b.pointAt as string)).toBe(true);
    }
  });

  it('readDiagnosticsTool 读出「哪个工具失败了」', () => {
    const withTool = input({
      context: [{ description: DSL_TOOL_CONTEXT_KEY, value: RENDER_DIAGRAM_TOOL }] as any,
    });
    expect(readDiagnosticsTool(withTool)).toBe(RENDER_DIAGRAM_TOOL);
    expect(readDiagnosticsTool(input())).toBeNull();
    // 只认自己的 key，别的 context 不会误判
    const other = input({
      context: [{ description: DSL_DIAGNOSTICS_CONTEXT_KEY, value: 'x' }] as any,
    });
    expect(readDiagnosticsTool(other)).toBeNull();
  });

  it('端到端：ScriptedAgent 拿到「图失败」的 context 时，产出的仍是图卡', async () => {
    const agent = new ScriptedAgent(NO_PACE);
    const events: any[] = [];
    for await (const event of agent.run(
      input({
        context: [
          { description: DSL_DIAGNOSTICS_CONTEXT_KEY, value: '[错误] units[34].kind：未知的符号种类' },
          { description: DSL_TOOL_CONTEXT_KEY, value: RENDER_DIAGRAM_TOOL },
        ] as any,
      })
    )) {
      events.push(event);
    }
    const start = events.find((e) => e.type === EventType.TOOL_CALL_START);
    expect(start?.toolCallName).toBe(RENDER_DIAGRAM_TOOL);
    const snapshot = events.find((e) => e.type === EventType.STATE_SNAPSHOT);
    expect(Object.keys(snapshot?.snapshot ?? {})).toEqual([STATE_DIAGRAM_KEY]);
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
