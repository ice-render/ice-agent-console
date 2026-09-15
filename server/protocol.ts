/**
 * AG-UI 的传输层：SSE 帧编码 + 事件构造小工具。
 *
 * 这里**故意不用 `@ag-ui/encoder`**。官方那个 encoder 为了同时支持 SSE 和二进制
 * (protobuf) 通道，把 `@ag-ui/proto` 也拖了进来；而这个工程只用 SSE，
 * 帧格式又只有"一行 `data:` + 空行"这么点东西。自己拼十几行，换来：
 *   - 依赖少一个（server 侧运行时依赖只有 `@ag-ui/core`）
 *   - 帧格式是显式可见的，调试 SSE 时不用去翻 node_modules
 *
 * 事件对象本身仍然用官方的 `@ag-ui/core`：`EventType` 是运行时 enum，
 * 用它做比较能挡住拼错事件名的低级错误（拼字符串字面量时这类错会静默丢事件）。
 */
import { EventType } from '@ag-ui/core';

/** AG-UI endpoint 的路径。前端和 e2e 都从这儿取，避免两边各写一份字符串。 */
export const AGUI_PATH = '/agui';

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // 有些反向代理会缓冲 SSE，这个头是让它们别缓冲（nginx 认）
  'X-Accel-Buffering': 'no',
};

/**
 * 把一条事件编码成 SSE 帧。
 *
 * 事件体里可能出现换行（比如流式文本的 delta 带 `\n`），SSE 规范要求把每一行
 * 都写成独立的 `data:` 行，接收方再用 `\n` join 回来。少写这一步的话，
 * 带换行的文本会把帧切断，症状是"偶尔丢一条事件"，很难查。
 */
export function encodeSse(event: unknown): string {
  const payload = JSON.stringify(event);
  const dataLines = payload.split('\n').map((line) => `data: ${line}`).join('\n');
  return `${dataLines}\n\n`;
}

/** SSE 注释帧。空闲时发它保活（接收方按规范会忽略注释行）。 */
export function encodeKeepAlive(): string {
  return ': keepalive\n\n';
}

/** 小工具：生成带前缀的 id，便于在日志和 e2e 里肉眼区分。 */
export function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export { EventType };
