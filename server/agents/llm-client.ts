/**
 * 跟大模型说话的那一层。**只有一个函数**，因为它要干的事只有一件：
 * 把一组消息 + 工具定义丢给 `/chat/completions`，拿回文本与工具调用。
 *
 * ## 为什么用 `fetch` 而不是引 SDK
 *
 * 这个工程要能接**任何 OpenAI 兼容的接口**（官方、Azure、DeepSeek、通义、本地 ollama /
 * vLLM / LM Studio…）。官方 SDK 会把它绑死在某一家的参数与错误形状上；而这里用到的
 * 只是 `POST /chat/completions` 一个端点，`fetch` 够了。
 *
 * 代价是要自己处理超时与错误形状 —— 都在下面这几十行里，而且有单测。
 *
 * ## 为什么**不**开 `stream: true`
 *
 * 开了的话文本就是边生成边到的，得在流里拼增量、还得处理"工具调用参数也是增量"这件更麻烦的事。
 * 而这个工程的事件序列是**一份纯函数**（`dsl-to-events.ts` 的 `planToEvents`）——
 * 真流式意味着要再写一份"边收边发"的实现，两份必然漂。
 *
 * 所以这里拿完整回复，再交给 `planToEvents` 按节奏分片播（跟剧本模式同一条路）。
 * 观感上"它在逐字打"是一样的，区别只在**开始打之前**要多等一次网络往返。
 * 要换成真流式，改这里 + `planToEvents` 旁边加一个流式变体，README 里有说明。
 */
import type { LlmConfig } from '../config';

/** 一条发给模型的消息。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** `role: 'tool'` 时必填 —— 对应哪一次工具调用。 */
  tool_call_id?: string;
  /** `role: 'assistant'` 且调了工具时带上（把上一轮的工具调用回灌给模型）。 */
  tool_calls?: any[];
}

export interface ToolCall {
  id: string;
  name: string;
  /** 已 `JSON.parse` 的参数。解析不了时是 `null`，调用方据此提示模型重来。 */
  args: any;
  /** 参数原文，解析失败时用来打日志。 */
  argsRaw: string;
}

export interface ChatResult {
  /** 模型说的文字（可能是空串 —— 它有时直接调工具不说话）。 */
  text: string;
  /** 模型要求调用的工具。没调就是 `null`。 */
  toolCall: ToolCall | null;
}

/** 接口返回了非 2xx 时抛它，带上状态码与响应体片段（排查 401 / 404 / 400 靠这个）。 */
export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string
  ) {
    super(`模型接口返回 ${status}：${body.slice(0, 300)}`);
    this.name = 'LlmHttpError';
  }
}

/**
 * 调一次模型。
 *
 * `signal` 用于"用户关掉页面 / 切走"时取消 —— 服务器已经在做这件事（见 index.ts），
 * 这里把它透传给 `fetch`，否则请求会一直挂着占住连接。
 */
export async function chat(
  config: LlmConfig,
  messages: ChatMessage[],
  tools: unknown[] | undefined,
  signal?: AbortSignal
): Promise<ChatResult> {
  const url = `${config.baseUrl}/chat/completions`;

  // 超时用 AbortController 自己管：`fetch` 没有超时选项，而模型接口偶尔会挂很久。
  // 用 `AbortSignal.any`（Node 20+）把"外部取消"与"自己超时"合并。
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error('timeout')), config.timeoutMs);
  const merged =
    signal && typeof (AbortSignal as any).any === 'function'
      ? (AbortSignal as any).any([signal, timeout.signal])
      : (signal ?? timeout.signal);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: config.temperature,
        ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
      }),
      signal: merged,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new LlmHttpError(res.status, body, url);
  }

  const json: any = await res.json();
  const message = json?.choices?.[0]?.message ?? {};
  const rawCalls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const first = rawCalls[0];

  let toolCall: ToolCall | null = null;
  if (first?.function?.name) {
    const argsRaw = typeof first.function.arguments === 'string' ? first.function.arguments : '';
    let args: any = null;
    try {
      args = argsRaw ? JSON.parse(argsRaw) : {};
    } catch {
      args = null; // 模型给了半截 JSON —— 交给上层提示它重来，不在这里抛
    }
    toolCall = {
      id: first.id || `call_${Date.now().toString(36)}`,
      name: first.function.name,
      args,
      argsRaw,
    };
  }

  return {
    text: typeof message.content === 'string' ? message.content : '',
    toolCall,
  };
}
