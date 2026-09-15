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
import type { AgentRun } from './agents/types';

const PORT = Number(process.env.ICE_AGENT_API_PORT || 8093);

/**
 * 节奏可以通过环境变量关掉。e2e 和本地快速验证用 `ICE_AGENT_PACE=0`，
 * 否则一条 run 要几秒钟，测试会白等。
 */
const pace: Pace = process.env.ICE_AGENT_PACE === '0' ? NO_PACE : DEFAULT_PACE;

/**
 * 换 agent 实现只动这一行。M2 大概是：
 *   const agent: AgentRun = process.env.LLM_API_KEY ? new LlmAgent(...) : new ScriptedAgent(pace);
 * 没有 key 就退回脚本化——保证 clone 下来不看文档也能跑。
 */
const agent: AgentRun = new ScriptedAgent(pace);

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
    sendJson(res, 200, { ok: true, agent: 'scripted', pace: pace.textChunk });
    return;
  }

  sendJson(res, 404, { error: `没有这个路由：${req.method} ${url}`, hint: `试试 POST ${AGUI_PATH}` });
});

server.listen(PORT, () => {
  console.log(`[agui] endpoint  http://localhost:${PORT}${AGUI_PATH}`);
  console.log(`[agui] agent     ScriptedAgent（确定性；节奏 ${pace.textChunk}ms/字）`);
});
