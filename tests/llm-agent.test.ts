/**
 * 模型路径：**开一个假的 OpenAI 兼容接口，让 `LlmAgent` 真的去调它**。
 *
 * 为什么不用 mock 掉 `fetch`：这件事要验证的是"配上一个 OpenAI 兼容接口就能用" ——
 * 那包括 URL 拼接、请求头、请求体形状、响应的解析、两次调用的循环。
 * mock 掉 `fetch` 就把"我拼的 URL 对不对"这件事也一起 mock 掉了，恰好漏掉最容易错的那部分。
 *
 * 所以这里起一个**真的 http 服务**（`node:http`，随机端口），像真接口一样回 JSON。
 * 顺带的好处：这套用例不需要任何 token 就能跑，CI 里也能跑。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RunAgentInput } from '@ag-ui/core';
import { LlmAgent, buildLlmPlan } from '../server/agents/llm';
import { NO_PACE } from '../server/agents/scripted';
import type { LlmConfig } from '../server/config';
import { DSL_DIAGNOSTICS_CONTEXT_KEY, VIEW_INTERACTION_CONTEXT_KEY } from '../shared/contract';

/** 一次假的回复。`text` 是内容，`tool` 是要调的工具。 */
interface FakeReply {
  text?: string;
  tool?: { name: string; args: any };
}

/**
 * 起一个假接口。`replies` 按调用顺序依次返回 —— 顺序本身就是断言对象
 * （第一次该是"选工具"，第二次该是"给结论"）。
 */
async function startFakeApi(replies: FakeReply[]): Promise<{
  baseUrl: string;
  calls: any[];
  close: () => Promise<void>;
}> {
  const calls: any[] = [];
  let i = 0;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
      const reply = replies[Math.min(i, replies.length - 1)];
      i += 1;
      const message: any = { role: 'assistant', content: reply.text ?? '' };
      if (reply.tool) {
        message.tool_calls = [
          {
            id: `call_${i}`,
            type: 'function',
            function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) },
          },
        ];
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const CONFIG = (baseUrl: string): LlmConfig => ({
  baseUrl,
  apiKey: 'sk-fake',
  model: 'fake-model',
  temperature: 0.3,
  timeoutMs: 5000,
});

function inputOf(message: string, extra: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: 't1',
    runId: 'r1',
    messages: [{ id: 'm1', role: 'user', content: message }],
    state: {},
    context: [],
    tools: [],
    forwardedProps: {},
    ...extra,
  } as unknown as RunAgentInput;
}

async function collect(agent: LlmAgent, input: RunAgentInput) {
  const out: any[] = [];
  for await (const e of agent.run(input)) out.push(e);
  return out;
}

const CHART_ARGS = {
  schemaVersion: 1,
  kind: 'bar',
  title: '销量',
  data: { columns: ['月', '量'], rows: [['1月', 1]] },
  encoding: { x: '月', y: '量' },
};

describe('buildLlmPlan：模型的选择 → 计划（纯函数，不碰网络）', () => {
  it('没调工具 → 纯文字计划，文字放 `beats`（不是 `intro`）', () => {
    const plan: any = buildLlmPlan({ text: '我还不支持这个。', toolCall: null }, null, 'r1');
    expect(plan.tool).toBeUndefined();
    expect(plan.beats).toEqual([{ text: '我还不支持这个。' }]);
    // `intro` 的语义是"画之前先说一句"，没有卡片就不该用它
    expect(plan.intro).toBeUndefined();
  });

  it('调 render_chart + 第二次给了结论 → intro / 卡片 / beat 三段齐', () => {
    const plan: any = buildLlmPlan(
      { text: '我拉一下数据。', toolCall: { name: 'render_chart', args: CHART_ARGS, id: 'c1' } },
      { text: '3 月最高。', toolCall: null },
      'r1'
    );
    expect(plan.tool).toBe('render_chart');
    expect(plan.stateKey).toBe('chart');
    expect(plan.payload).toBe(CHART_ARGS);
    expect(plan.intro).toBe('我拉一下数据。');
    expect(plan.beats).toEqual([{ text: '3 月最高。' }]);
    expect(plan.interrupt).toBeUndefined();
  });

  it('第二次调 `point_at` → 那一拍带上 pointAt（"指着讲"）', () => {
    const plan: any = buildLlmPlan(
      { text: '', toolCall: { name: 'render_chart', args: CHART_ARGS, id: 'c1' } },
      { text: '看这个尖峰。', toolCall: { name: 'point_at', args: { xValue: '3月' }, id: 'c2' } },
      'r1'
    );
    expect(plan.intro).toBeUndefined(); // 模型没先说，那就没有
    expect(plan.beats).toEqual([{ text: '看这个尖峰。', pointAt: '3月' }]);
  });

  it('调 collect_input → 计划里带**中断**（"要用户提供信息"在协议里就是 interrupt）', () => {
    const args = {
      kind: 'form',
      title: '下发前确认',
      description: '这三项确认后才下发',
      fields: [{ name: 'station', type: 'text', label: '泵站' }],
    };
    const plan: any = buildLlmPlan(
      { text: '', toolCall: { name: 'collect_input', args, id: 'c9' } },
      { text: '', toolCall: null },
      'r1'
    );
    expect(plan.tool).toBe('collect_input');
    expect(plan.stateKey).toBe('form');
    expect(plan.interrupt).toMatchObject({ id: 'collect-c9', reason: '下发前确认' });
    expect(plan.interrupt.message).toBe('这三项确认后才下发');
    // 第二次没说话时要有个兜底，否则表单卡后面的解说会空着
    expect(plan.beats[0].text).toContain('提交');
  });

  it('★ 模型调 render_diagram → 产出图卡而不是图表卡（不能只有 isForm 二元判断）', () => {
    const args = {
      kind: 'water-process',
      units: [
        { id: 'inlet', kind: 'inlet', left: 30, top: 120 },
        { id: 'outlet', kind: 'outlet', left: 1320, top: 400 },
      ],
      pipes: [{ id: 'p1', sourceId: 'inlet', targetId: 'outlet', medium: 'sewage' }],
    };
    const plan: any = buildLlmPlan(
      { text: '这是全厂工艺流程。', toolCall: { name: 'render_diagram', args, id: 'd1' } },
      { text: '主流程从进水一路走到排放口。', toolCall: null },
      'r1'
    );
    expect(plan.tool).toBe('render_diagram');
    expect(plan.stateKey).toBe('diagram');
    // 载荷原样透传（编译与校验都在前端）
    expect(plan.payload.kind).toBe('water-process');
    // 图卡不是中断卡
    expect(plan.interrupt).toBeUndefined();
    expect(plan.intro).toBe('这是全厂工艺流程。');
    expect(plan.beats[0].text).toContain('主流程');
  });

  it('图卡也能「指着讲」：point_at 的 xValue 可以是单元 id', () => {
    const plan: any = buildLlmPlan(
      { text: '', toolCall: { name: 'render_diagram', args: { kind: 'water-process', units: [] }, id: 'd2' } },
      { text: '厌氧池是释磷段。', toolCall: { name: 'point_at', args: { xValue: 'ana' }, id: 'p1' } },
      'r1'
    );
    expect(plan.tool).toBe('render_diagram');
    expect(plan.beats[0]).toMatchObject({ pointAt: 'ana' });
  });

  it('认不出来的工具名 → 退回图表卡（与加图卡之前的行为一致）', () => {
    const plan: any = buildLlmPlan(
      { text: '', toolCall: { name: 'render_pie_in_the_sky', args: { kind: 'bar' }, id: 'x1' } },
      null,
      'r1'
    );
    expect(plan.tool).toBe('render_chart');
    expect(plan.stateKey).toBe('chart');
  });

  it('参数不是合法 JSON → 如实说，不装作没事', () => {
    const plan: any = buildLlmPlan(
      { text: '', toolCall: { name: 'render_chart', args: null, id: 'c1', argsRaw: '{"kind":"bar"' } as any },
      null,
      'r1'
    );
    expect(plan.beats[0].text).toContain('不是合法 JSON');
    expect(plan.beats[0].text).toContain('{"kind":"bar"');
  });
});

describe('LlmAgent 真去调那个假接口', () => {
  it('两轮：先选工具、再给结论；URL / 头 / 体都拼对了', async () => {
    const api = await startFakeApi([
      { text: '我拉一下各渠道的月度销量。', tool: { name: 'render_chart', args: CHART_ARGS } },
      { text: '线上一直压着线下。' },
    ]);
    try {
      const events = await collect(new LlmAgent(CONFIG(api.baseUrl), NO_PACE), inputOf('看看销量'));

      // ---- 请求拼对了 ----
      expect(api.calls).toHaveLength(2);
      expect(api.calls[0].url).toBe('/v1/chat/completions');
      expect(api.calls[0].headers.authorization).toBe('Bearer sk-fake');
      expect(api.calls[0].body.model).toBe('fake-model');
      expect(api.calls[0].body.messages[0].role).toBe('system');
      expect(api.calls[0].body.messages.at(-1).content).toBe('看看销量');
      expect(api.calls[0].body.tool_choice).toBe('auto');

      // ---- 第二次的 messages 里带着工具结果（"把工具的产出回灌"） ----
      const second = api.calls[1].body.messages;
      expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
      expect(second.at(-2).tool_calls[0].function.name).toBe('render_chart');
      // 第二次**只给 point_at**：不给全量工具，否则模型可能接着又画一张
      expect(api.calls[1].body.tools.map((t: any) => t.function.name)).toEqual(['point_at']);

      // ---- 事件序列与剧本模式同一个骨架 ----
      const types = events.map((e) => e.type);
      expect(types[0]).toBe('RUN_STARTED');
      expect(types.at(-1)).toBe('RUN_FINISHED');
      expect(types).toContain('TOOL_CALL_START');
      expect(types).toContain('TOOL_CALL_ARGS');
      expect(types).toContain('TOOL_CALL_END');
      expect(types).toContain('STATE_SNAPSHOT');

      // 文字是**分片**发的（前端的"逐字打"靠这个）。
      // 断言"分片了"而不是"分了多少片" —— 片数取决于文本长度与 `pace.textChunk`，
      // 写死一个数字只是把当前配置抄一遍（第一版写的 `> 10` 就是这么来的，它没有意义）。
      const deltas = events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT');
      expect(deltas.length).toBeGreaterThanOrEqual(2);
      expect(deltas.some((d) => d.delta.length < '我拉一下各渠道的月度销量。'.length)).toBe(true);
      // 合起来必须还是原文，一个字不多不少
      const all = deltas.map((d) => d.delta).join('');
      expect(all).toContain('我拉一下各渠道的月度销量。');
      expect(all).toContain('线上一直压着线下。');

      // 工具名与前端的分派表一致 —— 不一致就渲染成另一种卡片了
      expect(events.find((e) => e.type === 'TOOL_CALL_START').toolCallName).toBe('render_chart');
      // 快照里是模型给的 DSL 原文
      expect(events.find((e) => e.type === 'STATE_SNAPSHOT').snapshot.chart).toEqual(CHART_ARGS);
    } finally {
      await api.close();
    }
  });

  it('表单：调 collect_input → `RUN_FINISHED` 带 interrupt（前端进 waiting）', async () => {
    const api = await startFakeApi([
      { tool: { name: 'collect_input', args: { kind: 'form', title: '确认参数', fields: [{ name: 'a', type: 'text' }] } } },
      { text: '填好我就继续。' },
    ]);
    try {
      const events = await collect(new LlmAgent(CONFIG(api.baseUrl), NO_PACE), inputOf('要下发指令'));
      const finished: any = events.at(-1);
      expect(finished.type).toBe('RUN_FINISHED');
      expect(finished.outcome.type).toBe('interrupt');
      expect(finished.outcome.interrupts[0].id).toBe('collect-call_1');
      expect(events.find((e) => e.type === 'TOOL_CALL_START').toolCallName).toBe('collect_input');
    } finally {
      await api.close();
    }
  });

  it('模型直接回一句话（没调工具）→ 只有文字，没有卡片', async () => {
    const api = await startFakeApi([{ text: '我还没接上这个能力。' }]);
    try {
      const events = await collect(new LlmAgent(CONFIG(api.baseUrl), NO_PACE), inputOf('今天天气'));
      expect(api.calls).toHaveLength(1); // 没调工具就不再问第二次
      expect(events.some((e) => e.type === 'TOOL_CALL_START')).toBe(false);
      expect(events.some((e) => e.type === 'STATE_SNAPSHOT')).toBe(false);
      expect(
        events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta).join('')
      ).toBe('我还没接上这个能力。');
    } finally {
      await api.close();
    }
  });

  it('把诊断与画布交互翻译进提示词（自修复回路与追问都靠它）', async () => {
    const api = await startFakeApi([{ text: '收到。' }]);
    try {
      await collect(
        new LlmAgent(CONFIG(api.baseUrl), NO_PACE),
        inputOf('改一下', {
          context: [
            { description: DSL_DIAGNOSTICS_CONTEXT_KEY, value: '[错误] 不支持的字段类型「richtext」' },
            { description: VIEW_INTERACTION_CONTEXT_KEY, value: '{"kind":"item-click","xValue":"3月"}' },
          ] as any,
        })
      );
      const sent = JSON.stringify(api.calls[0].body.messages);
      expect(sent).toContain('没有通过渲染端的校验');
      expect(sent).toContain('richtext');
      expect(sent).toContain('item-click');
      expect(sent).toContain('3月');
    } finally {
      await api.close();
    }
  });

  it('接口报错时**原样抛出去**（不悄悄退回剧本）', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const events = collect(new LlmAgent(CONFIG(`http://127.0.0.1:${port}/v1`), NO_PACE), inputOf('hi'));
      await expect(events).rejects.toThrow(/401/);
      await expect(events).rejects.toThrow(/Invalid API key/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
