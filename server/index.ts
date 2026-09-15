/**
 * AG-UI endpoint。原生 node:http，**运行时依赖只有 `@ag-ui/core` 一个**。
 *
 * 它的身份是「AG-UI endpoint」，不是「LLM 代理」。M1 它承载 ScriptedAgent，
 * M2 换成 LlmAgent，它的形状都不用变——这也是为什么它现在就应该存在，
 * 而不是等到接模型时再写。
 *
 * 不用 express：这里只有一个 POST 路由 + 一个健康检查，原生 http 反而更短，
 * 而且少一串中间件就少一串"到底是我的问题还是中间件的问题"。
 */
import http from 'node:http';
import { RunAgentInputSchema } from '@ag-ui/core';
import { AGUI_PATH, SSE_HEADERS, encodeKeepAlive, encodeSse } from './protocol';
import { ScriptedAgent, DEFAULT_PACE, NO_PACE, type Pace } from './agents/scripted';
import { LlmAgent } from './agents/llm';
import { describeConfig, loadConfig } from './config';
import type { AgentRun } from './agents/types';

const PORT = Number(process.env.ICE_AGENT_API_PORT || 8099);

/**
 * 节奏可以通过环境变量关掉。e2e 和本地快速验证用 `ICE_AGENT_PACE=0`，
 * 否则一条 run 要几秒钟，测试会白等。
 */
const pace: Pace = process.env.ICE_AGENT_PACE === '0' ? NO_PACE : DEFAULT_PACE;

/**
 * **两种模式，一个接口。**
 *
 * 配了模型（`ICE_LLM_API_KEY`）就走 `LlmAgent`，没配就走 `ScriptedAgent`。
 * 换实现只动这一行 —— 因为两者的产出都是同一串 AG-UI 事件，
 * 下面的传输层、前端归约器、渲染层全都分辨不出来也不需要分辨。
 *
 * "没配就走剧本"不是降级：这个工程本来就是从剧本模式长出来的（M1），
 * 接模型是 M2。所以 clone 下来不看文档也能跑，配了 key 就换成真模型。
 */
const config = loadConfig();

/** 选实现。这一行就是 M1 / M2 的开关。 */
const agent: AgentRun =
  config.mode === 'llm' && config.llm ? new LlmAgent(config.llm, pace) : new ScriptedAgent(pace);

const CORS_HEADERS: Record<string, string> = {
  // 本地演示，直接开。生产要收敛到具体来源。
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      // 本地演示，给个上限防止自己把自己喂爆
      if (size > 2 * 1024 * 1024) {
        reject(new Error('请求体过大（>2MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function handleRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let input;
  try {
    const raw = await readBody(req);
    const parsed = RunAgentInputSchema.safeParse(JSON.parse(raw || '{}'));
    if (!parsed.success) {
      // 协议明确要求：不合规的输入返回 422，而不是硬着头皮跑
      sendJson(res, 422, { error: 'RunAgentInput 校验失败', issues: parsed.error.issues });
      return;
    }
    input = parsed.data;
  } catch (err) {
    sendJson(res, 400, { error: `请求体解析失败：${(err as Error).message}` });
    return;
  }

  // ---------- 从这里开始是 SSE。一旦写了头，就只能用事件报错了 ----------
  res.writeHead(200, { ...CORS_HEADERS, ...SSE_HEADERS });
  // 立刻冲一次，让客户端尽快进入"已连接"状态而不是等第一条事件
  res.flushHeaders?.();

  const abort = new AbortController();
  // 客户端断开（关标签页、切走）时要停掉 agent，否则后面还在白白跑
  req.on('close', () => abort.abort());

  // 空闲保活：SSE 规范里的注释帧，接收方会忽略。慢剧本时别让中间的代理把连接掐了。
  let lastWrite = Date.now();
  const keepAlive = setInterval(() => {
    if (Date.now() - lastWrite >= 15_000) {
      res.write(encodeKeepAlive());
      lastWrite = Date.now();
    }
  }, 5_000);

  let count = 0;
  try {
    for await (const event of agent.run(input, abort.signal)) {
      if (abort.signal.aborted) break;
      res.write(encodeSse(event));
      lastWrite = Date.now();
      count++;
    }
  } catch (err) {
    // 用协议原生的事件报错，而不是把连接掐了让前端自己猜
    res.write(
      encodeSse({
        type: 'RUN_ERROR',
        message: (err as Error).message || 'agent 执行失败',
      })
    );
  } finally {
    clearInterval(keepAlive);
    res.end();
  }

  console.log(
    `[agui] run ${input.runId} — thread ${input.threadId} — ${count} 条事件` +
      (abort.signal.aborted ? '（客户端提前断开）' : '')
  );
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method === 'POST' && url.startsWith(AGUI_PATH)) {
    void handleRun(req, res);
    return;
  }

  if (req.method === 'GET' && url.startsWith('/health')) {
    // 探活也报当前模式 —— 排查"为什么没走模型"时第一眼看的就是这里
    sendJson(res, 200, {
      ok: true,
      agent: config.mode,
      ...(config.mode === 'llm' && config.llm ? { model: config.llm.model, baseUrl: config.llm.baseUrl } : {}),
      reason: config.reason,
      pace: pace.textChunk,
    });
    return;
  }

  sendJson(res, 404, { error: `没有这个路由：${req.method} ${url}`, hint: `试试 POST ${AGUI_PATH}` });
});

server.listen(PORT, () => {
  console.log(`[agui] endpoint  http://localhost:${PORT}${AGUI_PATH}`);
  console.log(
    config.mode === 'llm'
      ? `[agui] agent     LlmAgent（真模型；节奏 ${pace.textChunk}ms/字）`
      : `[agui] agent     ScriptedAgent（确定性剧本；节奏 ${pace.textChunk}ms/字）`
  );
  for (const line of describeConfig(config)) console.log(line);
});
