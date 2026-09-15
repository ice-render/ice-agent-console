/**
 * SSE 解析的边界情况。
 *
 * 这些用例的价值在于：它们全是"真实网络下一定会遇到、但靠肉眼调试几乎不可能复现"的情况。
 * 分片边界把一行劈成两半、\r\n 切在中间、`data:` 值里带换行——
 * 每一条都在真实链路上以"偶尔丢一条事件"的形式出现过。
 */
import { SseParser, parseSseJson } from '../src/domain/agui/sse';

describe('SseParser', () => {
  it('解析一条完整的帧', () => {
    const parser = new SseParser();
    const out = parser.push('data: {"type":"RUN_STARTED"}\n\n');
    expect(out).toHaveLength(1);
    expect(out[0].data).toBe('{"type":"RUN_STARTED"}');
  });

  it('一次喂多条帧', () => {
    const parser = new SseParser();
    const out = parser.push('data: {"a":1}\n\ndata: {"b":2}\n\n');
    expect(out.map((e) => e.data)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('分片切在一行中间时不提前派发', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"ty')).toHaveLength(0);
    expect(parser.push('pe":"RUN_STARTED"}')).toHaveLength(0);
    const out = parser.push('\n\n');
    expect(out).toHaveLength(1);
    expect(out[0].data).toBe('{"type":"RUN_STARTED"}');
  });

  it('分片正好切在 \\r\\n 中间时不会多出一个空行', () => {
    // 这是最阴的一种：末尾的 \r 如果被当成行尾，就会凑出一个"空行"，
    // 把还不完整的事件提前派发掉。症状是"偶尔丢事件"。
    const parser = new SseParser();
    expect(parser.push('data: {"a":1}\r')).toHaveLength(0);
    const out = parser.push('\n\r\n');
    expect(out).toHaveLength(1);
    expect(out[0].data).toBe('{"a":1}');
  });

  it('CRLF 行尾正常工作', () => {
    const parser = new SseParser();
    const out = parser.push('data: {"a":1}\r\n\r\n');
    expect(out).toHaveLength(1);
    expect(out[0].data).toBe('{"a":1}');
  });

  it('忽略注释行（保活帧）', () => {
    const parser = new SseParser();
    const out = parser.push(': keepalive\n\n');
    expect(out).toHaveLength(0);
  });

  it('忽略 event / id 字段但把它们带上', () => {
    const parser = new SseParser();
    const out = parser.push('event: message\nid: 7\ndata: {"a":1}\n\n');
    expect(out[0].event).toBe('message');
    expect(out[0].id).toBe('7');
  });

  it('多行 data 用换行拼回来', () => {
    const parser = new SseParser();
    const out = parser.push('data: {"delta":"a\ndata: b"}\n\n');
    expect(out[0].data).toBe('{"delta":"a\nb"}');
  });

  it('冒号后的单个空格会被去掉（但其余空格保留）', () => {
    const parser = new SseParser();
    const out = parser.push('data:  {"a":1}\n\n');
    expect(out[0].data).toBe(' {"a":1}');
  });

  it('flush 处理没有收尾空行的最后一帧', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a":1}\n')).toHaveLength(0);
    const out = parser.flush();
    expect(out).toHaveLength(1);
    expect(out[0].data).toBe('{"a":1}');
  });

  it('坏帧返回 null 而不是抛异常', () => {
    expect(parseSseJson({ data: '{不是 JSON' })).toBeNull();
  });
});

describe('parseSseJson', () => {
  it('解析正常 JSON', () => {
    expect(parseSseJson({ data: '{"type":"RUN_ERROR","message":"x"}' })).toEqual({
      type: 'RUN_ERROR',
      message: 'x',
    });
  });
});
