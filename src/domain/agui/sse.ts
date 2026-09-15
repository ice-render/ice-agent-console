/**
 * SSE 解析：把 fetch 的文本分片还原成一条条事件。
 *
 * 单独拎出来当纯逻辑（内部只有 buffer 状态），所以能直接单测——包括那些
 * "分片边界把一行劈成两半"的恶心情况，那些在真实网络下一定会遇到，
 * 但靠肉眼调试几乎不可能复现。
 *
 * 只实现接收端需要的那部分规范：`data:` 累积、空行派发、`:` 开头是注释。
 * `event:` / `id:` / `retry:` 一并解析但不使用（AG-UI 的事件类型在 JSON 体的 `type` 字段里）。
 */

export interface RawSseEvent {
  event?: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];
  private eventName: string | undefined;
  private lastId: string | undefined;

  /** 喂一个文本分片，吐出这次能完整解析出来的事件。 */
  push(chunk: string): RawSseEvent[] {
    this.buffer += chunk;

    // 行尾统一成 \n。但如果分片正好切在 \r\n 中间，末尾那个 \r 得先扣下来，
    // 否则它会被当成一个空行，把一条完整事件提前派发掉——症状是"偶尔丢事件"。
    let pendingTail = '';
    if (this.buffer.endsWith('\r')) {
      pendingTail = '\r';
      this.buffer = this.buffer.slice(0, -1);
    }
    const text = this.buffer.replace(/\r\n?/g, '\n');

    const lines = text.split('\n');
    // 最后一段没有换行结尾，说明这行还没收完，留回缓冲区等下一个分片
    const incomplete = lines.pop() ?? '';
    this.buffer = incomplete + pendingTail;

    const out: RawSseEvent[] = [];
    for (const line of lines) {
      const dispatched = this.consumeLine(line);
      if (dispatched) out.push(dispatched);
    }
    return out;
  }

  /** 流结束时调用：把缓冲区里可能残留的一个完整行处理掉。 */
  flush(): RawSseEvent[] {
    const out: RawSseEvent[] = [];
    if (this.buffer) {
      const dispatched = this.consumeLine(this.buffer);
      this.buffer = '';
      if (dispatched) out.push(dispatched);
    }
    const last = this.dispatch();
    if (last) out.push(last);
    return out;
  }

  private consumeLine(line: string): RawSseEvent | null {
    // 空行 = 派发
    if (line === '') return this.dispatch();

    // 注释行（保活帧走这里）。按规范直接忽略。
    if (line.startsWith(':')) return null;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    // 规范：冒号后可选一个空格，要去掉
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'data':
        this.dataLines.push(value);
        break;
      case 'event':
        this.eventName = value;
        break;
      case 'id':
        this.lastId = value;
        break;
      default:
        // retry 等字段接收端用不到，忽略
        break;
    }
    return null;
  }

  private dispatch(): RawSseEvent | null {
    if (this.dataLines.length === 0) {
      // 没有 data 的行组（比如纯注释）不构成事件
      this.eventName = undefined;
      return null;
    }
    const event: RawSseEvent = {
      data: this.dataLines.join('\n'),
      event: this.eventName,
      id: this.lastId,
    };
    this.dataLines = [];
    this.eventName = undefined;
    return event;
  }
}

/**
 * 把原始事件解成 JSON 对象。解析失败返回 null 而不是抛——
 * 一条坏帧不该让整条流挂掉，协议给的容错口径就是"认不出来的丢".
 */
export function parseSseJson(raw: RawSseEvent): any | null {
  try {
    return JSON.parse(raw.data);
  } catch {
    return null;
  }
}
