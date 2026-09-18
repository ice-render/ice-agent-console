/**
 * 推 → 拉 的接缝：把"回调式"的模型流变成"可 await 的事件流"。
 *
 * `AgentRun.run()` 是**拉**的（`for await`），而模型 SDK / fetch 的流是**推**的
 * （`onDelta(delta)`）。中间必须有个缓冲，否则要么把整个回复攒完再发（那就没有流式了），
 * 要么在回调里直接产事件（JavaScript 不允许从回调里 `yield` 给外面的生成器）。
 *
 * 这个类就是那个缓冲，语义只有三条：
 * - `push` 进来的先攒着，有人在等就直接交给等待者（不攒、不延迟）；
 * - `close()` 之后迭代正常结束；
 * - `fail(err)` 之后迭代**抛出**这个错误 —— 这一条是必须的：
 *   接口 401 之类必须原样冒到 `RUN_ERROR`，静默结束会让用户以为"模型没话说"。
 */
export default class AsyncEventQueue<T> {
  private items: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private error: unknown = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    this.__finish();
  }

  fail(error: unknown): void {
    this.error = error;
    this.__finish();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift() as T;
        continue;
      }
      if (this.error) throw this.error;
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (next.done) {
        if (this.error) throw this.error;
        return;
      }
      yield next.value;
    }
  }

  private __finish(): void {
    this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((waiter) => waiter({ value: undefined as unknown as T, done: true }));
  }
}
