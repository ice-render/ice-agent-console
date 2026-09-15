/**
 * 客户端传输层：把一次 run 变成一串事件回调。
 *
 * **薄到几乎没逻辑是故意的。** AG-UI 的客户端侧本来就只是"POST 一个输入、
 * 读一条 SSE 流"，协议的全部重量在后端的编排上。这一层越薄，说明协议越好用——
 * 如果这里长出一堆状态机，那问题多半出在别处。
 *
 * 之所以不用官方的 `@ag-ui/client`：它会带上 rxjs 和二进制通道的支持，
 * 而这个工程只用 SSE。四十行 fetch + 分片解析换来零额外依赖，而且出问题时
 * 栈里全是我们自己的代码。
 */
import { SseParser, parseSseJson } from './sse';

/**
 * 后端地址。dev 下前端在 8100、后端在 8099，跨源——所以 server 开了 CORS。
 * 这里**故意不走 webpack-dev-server 的反向代理**：SSE 经中间层容易被缓冲，
 * 出问题时很难判断是协议问题还是代理问题。
 */
export function apiUrl(): string {
  const override = (globalThis as any).ICE_AGENT_API;
  return override || 'http://localhost:8099/agui';
}

export interface RunMessage {
  id: string;
  role: string;
  content: string;
}

/** 对应协议里的 `RunAgentInput`。 */
export interface RunRequest {
  threadId: string;
  runId: string;
  messages: RunMessage[];
  state?: any;
  /** 应用扩展通道。自修复回路就是靠它把渲染端诊断带回去的。 */
  context?: Array<{ description: string; value: string }>;
}

export interface RunHandlers {
  onEvent: (event: any) => void;
  onError?: (error: Error) => void;
  onDone?: () => void;
}

/**
 * 跑一次 run，事件按到达顺序交给 onEvent。
 *
 * 中途用 `signal` 可以取消（关页面、切会话）——这会同时 abort 掉 fetch 和后端的 agent。
 */
export async function runAgent(
  request: RunRequest,
  handlers: RunHandlers,
  signal?: AbortSignal
): Promise<void> {
  const parser = new SseParser();

  try {
    const response = await fetch(apiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId: request.threadId,
        runId: request.runId,
        state: request.state ?? {},
        messages: request.messages,
        context: request.context ?? [],
        tools: [],
        forwardedProps: {},
      }),
      signal,
    });

    if (!response.ok) {
      // 422 是协议规定的"输入不合规"。把 body 里的 issues 带出来，别只说"失败了"。
      let detail = '';
      try {
        const body = await response.json();
        detail = body?.issues ? `：${JSON.stringify(body.issues)}` : body?.error ? `：${body.error}` : '';
      } catch {
        /* body 不是 JSON，忽略 */
      }
      throw new Error(`AG-UI endpoint 返回 ${response.status}${detail}`);
    }

    if (!response.body) {
      throw new Error('响应没有 body——这个环境不支持流式读取？');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const raw of parser.push(decoder.decode(value, { stream: true }))) {
        const event = parseSseJson(raw);
        // 坏帧直接丢：一条解析不了的帧不该让整条流挂掉
        if (event) handlers.onEvent(event);
      }
    }
    for (const raw of parser.flush()) {
      const event = parseSseJson(raw);
      if (event) handlers.onEvent(event);
    }

    handlers.onDone?.();
  } catch (err) {
    // 用户主动取消不算错误
    if ((err as Error)?.name === 'AbortError') return;
    handlers.onError?.(err as Error);
  }
}
