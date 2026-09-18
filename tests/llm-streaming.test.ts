/**
 * 流式接模型：**边生成边发**这条链路。
 *
 * 与 `llm-agent.test.ts` 一样，这里也起一个**真的** http 服务，只不过它按 SSE 回：
 * 帧是一个一个写的，中间还夹着推理模型特有的 `reasoning_content`、
 * 以及被拆开的工具调用参数。这些都是真实接口的行为，mock 掉就测不到。
 *
 * 钉住四件事：
 * ① 正文增量**在整次调用结束之前**就变成 `TEXT_MESSAGE_CONTENT`（否则谈不上流式）；
 * ② 推理过程走 `CUSTOM ice/reasoning`，并且带 `phase`；
 * ③ 工具调用参数跨帧拼接正确（`render_chart` 的 DSL 完整、能解析）；
 * ④ `[DONE]` 之后正常收尾，且**每条文字消息都有 START / END**（前端靠 END 标 done）。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RunAgentInput } from '@ag-ui/core';
import { LlmAgent } from '../server/agents/llm';
import { NO_PACE } from '../server/agents/scripted';
import type { LlmConfig } from '../server/config';
import { EVT_REASONING } from '../shared/contract';

/** 一帧要写的东西。`delay` 是写之前的等待（毫秒），用来放大"边生成边到"这件事。 */
interface Frame {
  delta: any;
  delay?: number;
}

/**
 * 起一个按 SSE 回的假接口。`turns` 按调用顺序取 —— 第一次是"选工具"，第二次是"给结论"，
 * 两次回什么完全不同，所以必须按轮次分开（第一版两轮共用一串帧，
 * 于是第二轮的 reasoning 也被当成第一轮的，断言跟着错）。
 */
async function startSseApi(turns: Frame[][]): Promise<{ baseUrl: string; bodies: any[]; close: () => Promise<void> }> {
  const bodies: any[] = [];
  let turn = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      bodies.push(JSON.parse(body || '{}'));
      const frames = turns[Math.min(turn, turns.length - 1)];
      turn += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      for (const frame of frames) {
        if (frame.delay) await new Promise((r) => setTimeout(r, frame.delay));
        res.write(`data: ${JSON.stringify({ choices: [{ delta: frame.delta }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    bodies,
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

const inputOf = (text: string): RunAgentInput => ({
  threadId: 't1',
  runId: 'r1',
  messages: [{ id: 'm1', role: 'user', content: text }],
  state: {},
  tools: [],
  context: [],
} as any);

async function collect(agent: LlmAgent, input: RunAgentInput): Promise<any[]> {
  const events: any[] = [];
  for await (const event of agent.run(input)) events.push(event);
  return events;
}

const CHART_ARGS = { kind: 'bar', title: '各渠道月度销量', data: { categories: ['1月'], rows: [{ name: '线上', values: [120] }] } };

describe('流式接模型', () => {
  it('推理过程 → CUSTOM ice/reasoning（带 phase），正文 → 分片 TEXT_MESSAGE_CONTENT', async () => {
    const api = await startSseApi([
      // 第一次调用：思考 + 一句开场白 + 一个工具调用（参数分两帧，模拟真实拆分）
      [
        { delta: { reasoning_content: '用户在问销量，' }, delay: 20 },
        { delta: { reasoning_content: '我该调 render_chart。' } },
        { delta: { content: '我拉一下' } },
        { delta: { content: '各渠道的月度销量。' } },
        { delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'render_chart', arguments: '{"kind":"bar",' } }] } },
        { delta: { tool_calls: [{ index: 0, function: { arguments: '"title":"各渠道月度销量","data":{"categories":["1月"],"rows":[{"name":"线上","values":[120]}]}}' } }] } },
      ],
      // 第二次调用（回灌工具结果之后）：只有结论文本
      [
        { delta: { content: '线上' }, delay: 20 },
        { delta: { content: '压着线下。' } },
      ],
    ]);
    try {
      const events = await collect(new LlmAgent(CONFIG(api.baseUrl), NO_PACE), inputOf('看看销量'));

      // ① 流式：正文被拆成多条增量，且拼回去一字不差
      const contents = events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT');
      expect(contents.length).toBeGreaterThanOrEqual(4);
      expect(contents.map((e) => e.delta).join('')).toContain('我拉一下各渠道的月度销量。');
      expect(contents.map((e) => e.delta).join('')).toContain('线上压着线下。');

      // ② 每条文字消息都成对（START / END）—— 前端靠 END 把这一条标 done
      const starts = events.filter((e) => e.type === 'TEXT_MESSAGE_START').map((e) => e.messageId);
      const ends = events.filter((e) => e.type === 'TEXT_MESSAGE_END').map((e) => e.messageId);
      expect(starts.length).toBe(2); // 第一次调用一句、第二次调用一句
      expect(ends).toEqual(starts);

      // ③ 思考过程单独一条通道，phase 区分"哪一次调用"
      const reasoning = events.filter((e) => e.type === 'CUSTOM' && e.name === EVT_REASONING);
      expect(reasoning.map((e) => e.delta ?? e.value.delta).join('')).toContain('我该调 render_chart');
      expect(new Set(reasoning.map((e) => e.value.phase))).toEqual(new Set([0]));

      // ④ 工具调用跨帧拼好了，快照里是完整可解析的 DSL
      const snapshot = events.find((e) => e.type === 'STATE_SNAPSHOT');
      expect(snapshot.snapshot.chart).toEqual(CHART_ARGS);
      expect(events.find((e) => e.type === 'TOOL_CALL_START').toolCallName).toBe('render_chart');

      // ⑤ 边界：RUN_STARTED 在最前、RUN_FINISHED 在最后
      expect(events[0].type).toBe('RUN_STARTED');
      expect(events.at(-1).type).toBe('RUN_FINISHED');

      // ⑥ 请求体里真的开了流
      expect(api.bodies[0].stream).toBe(true);
    } finally {
      await api.close();
    }
  });

  it('服务端不按流式回（忽略 stream:true）时退回整包解析，内容不丢', async () => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '整包回的。' } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const events = await collect(new LlmAgent(CONFIG(`http://127.0.0.1:${port}/v1`), NO_PACE), inputOf('随便说说'));
      const text = events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta).join('');
      expect(text).toContain('整包回的。');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('接口报错照样原样抛出（不静默降级成剧本）', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(collect(new LlmAgent(CONFIG(`http://127.0.0.1:${port}/v1`), NO_PACE), inputOf('看看销量'))).rejects.toThrow(
        /401/
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
