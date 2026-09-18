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

/** 流式回调：**增量**，调用方自己拼。 */
export interface ChatStreamHandlers {
  /** 推理模型的思考过程（`reasoning_content`）。多数接口不发这条。 */
  onReasoning?: (delta: string) => void;
  /** 正文增量。 */
  onContent?: (delta: string) => void;
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

/**
 * 把两条取消信号合成一条：外部取消（页面关掉）与自己的超时。
 *
 * `AbortSignal.any` 是 Node 20+ 才有的，旧运行时退回"只用外部信号" ——
 * 少一层超时保护，但不至于报错。
 */
function mergeAbort(signal: AbortSignal | undefined, timeout: AbortSignal): AbortSignal {
  return signal && typeof (AbortSignal as any).any === 'function'
    ? (AbortSignal as any).any([signal, timeout])
    : (signal ?? timeout);
}

/** 把非流式的响应体解析成 `ChatResult`（流式兜底与单测的假接口都走它）。 */
function parseChatJson(json: any): ChatResult {
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
      args = null;
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

/**
 * 流式调一次模型：边收边把增量交给回调，最后返回拼好的完整结果。
 *
 * 返回类型与 `chat()` 一样，所以调用方**只关心"要不要流"**，拼装逻辑一处。
 *
 * ## 三个必须处理的现实
 *
 * 1. **推理模型**：正文之前先来一大段 `reasoning_content`（LM Studio / vLLM 用的字段名，
 *    有些实现叫 `reasoning`）。本地跑 qwopus-coder 时，一次回复的两分钟里绝大部分是它。
 *    不转出来，界面上就只有转圈。
 * 2. **工具调用也是增量的**：`tool_calls[].function.arguments` 一个片段一个片段地来，
 *    必须按 `index` 拼；`id` / `name` 一般只在第一片给一次（重复给时以第一次为准，
 *    拼起来会把函数名接成 `render_chartrender_chart`）。
 * 3. **不是所有服务端都真支持 SSE**：有些网关忽略 `stream: true` 直接回一坨 JSON。
 *    所以按 `content-type` 判断，不是 `text/event-stream` 就退回整包解析 ——
 *    这个兜底同时让"老的单测假接口"继续可用。
 *
 * 超时**覆盖整个流的读取过程**（不是只到响应头），本地小模型慢的时候靠它兜住。
 */
export async function chatStream(
  config: LlmConfig,
  messages: ChatMessage[],
  tools: unknown[] | undefined,
  signal: AbortSignal | undefined,
  handlers: ChatStreamHandlers = {}
): Promise<ChatResult> {
  const url = `${config.baseUrl}/chat/completions`;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error('timeout')), config.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: config.temperature,
        stream: true,
        ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
      }),
      signal: mergeAbort(signal, timeout.signal),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new LlmHttpError(res.status, body, url);
    }

    const contentType = String(res.headers.get('content-type') || '');
    if (!contentType.includes('text/event-stream')) {
      // 服务端没按流式回：整包读，当一次普通调用处理（内容照样对，只是没有"边想边说"）
      const json: any = await res.json();
      const parsed = parseChatJson(json);
      if (parsed.text) handlers.onContent?.(parsed.text);
      return parsed;
    }
    if (!res.body) {
      throw new Error('[llm] 接口声明是流式响应，但没有响应体');
    }

    const reader: any = (res.body as any).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    const calls = new Map<number, { id?: string; name?: string; args: string }>();
    let finished = false;

    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf('\n\n');
      while (sep >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const rawLine of frame.split('\n')) {
          const line = rawLine.trim();
          if (!line || line.startsWith(':')) continue; // 注释帧（保活）
          if (!line.startsWith('data:')) continue;
          const payload = line.slice('data:'.length).trim();
          if (payload === '[DONE]') {
            finished = true;
            break;
          }
          let json: any;
          try {
            json = JSON.parse(payload);
          } catch {
            continue; // 半截帧 / 非 JSON 的心跳，跳过而不是把整轮搞崩
          }
          const delta = json?.choices?.[0]?.delta ?? {};
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoning === 'string' && reasoning) handlers.onReasoning?.(reasoning);
          if (typeof delta.content === 'string' && delta.content) {
            text += delta.content;
            handlers.onContent?.(delta.content);
          }
          const toolCalls: any[] = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
          for (const piece of toolCalls) {
            const index = Number.isFinite(piece?.index) ? Number(piece.index) : 0;
            const current = calls.get(index) ?? { args: '' };
            if (piece?.id && !current.id) current.id = piece.id;
            if (piece?.function?.name && !current.name) current.name = piece.function.name;
            if (typeof piece?.function?.arguments === 'string') current.args += piece.function.arguments;
            calls.set(index, current);
          }
        }
        if (finished) break;
        sep = buffer.indexOf('\n\n');
      }
    }

    const first = calls.get(0);
    let toolCall: ToolCall | null = null;
    if (first?.name) {
      let args: any = null;
      try {
        args = first.args ? JSON.parse(first.args) : {};
      } catch {
        args = null; // 半截 JSON —— 交给上层提示模型重来
      }
      toolCall = {
        id: first.id || `call_${Date.now().toString(36)}`,
        name: first.name,
        args,
        argsRaw: first.args,
      };
    }
    return { text, toolCall };
  } finally {
    clearTimeout(timer);
  }
}
