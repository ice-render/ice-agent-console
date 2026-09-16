/**
 * transport 开关与协议输入映射。
 *
 * 这两样都是**纯函数**，所以边界能穷举 —— 而它们恰好是最容易写错的地方：
 * 模式判定的优先级搞反了会让"演示产物里切不回后端"，
 * 输入映射漏一个字段会让服务端收不到该收的东西（而症状可能是"某条回路莫名其妙没反应"）。
 */
import { BUILD_DEFAULT_DEMO, pickTransport, resolveRunMode } from '../src/domain/agui/transport';
import { toRunAgentInput, type RunRequest } from '../src/domain/agui/run-input';
import { runAgent } from '../src/domain/agui/client';
import { runAgentLocally } from '../src/domain/agui/local-agent';

describe('resolveRunMode', () => {
  it('没有参数时用构建期默认', () => {
    expect(resolveRunMode('', false)).toBe('server');
    expect(resolveRunMode('', true)).toBe('demo');
    // 只有 `?` 也算没有
    expect(resolveRunMode('?', false)).toBe('server');
  });

  it('★ URL 显式指定**优先于**构建期默认（两个方向都要）', () => {
    // 演示产物（默认 demo）里要能切回后端：`?demo=0`
    expect(resolveRunMode('?demo=0', true)).toBe('server');
    // 普通产物（默认 server）里也要能切到演示：`?demo=1`（调试时很有用）
    expect(resolveRunMode('?demo=1', false)).toBe('demo');
  });

  it('1/true 都算开，0/false 都算关', () => {
    for (const on of ['1', 'true']) {
      expect({ on, mode: resolveRunMode(`?demo=${on}`, false) }).toEqual({ on, mode: 'demo' });
    }
    for (const off of ['0', 'false']) {
      expect({ off, mode: resolveRunMode(`?demo=${off}`, true) }).toEqual({ off, mode: 'server' });
    }
  });

  it('★ 非法值 / 空值落回构建期默认（不报错、也不白屏）', () => {
    // URL 参数是给人和分享链接用的，手抖打错一个不该让页面挂掉。
    // 口径与 `?theme=` 一致（那边也是不认识的值就落回默认主题）。
    for (const bad of ['?demo=whatever', '?demo=', '?demo', '?other=1', '?demo=2', '?demo=yes']) {
      expect({ bad, plain: resolveRunMode(bad, false) }).toEqual({ bad, plain: 'server' });
      expect({ bad, demo: resolveRunMode(bad, true) }).toEqual({ bad, demo: 'demo' });
    }
  });

  it('和其他查询参数混在一起也能认出来', () => {
    expect(resolveRunMode('?theme=dark&demo=1', false)).toBe('demo');
    expect(resolveRunMode('?demo=1&theme=dark', false)).toBe('demo');
    expect(resolveRunMode('?theme=dark&demo=0', true)).toBe('server');
  });

  it('构建期默认值在 jest 里是 false（DefinePlugin 没参与）', () => {
    // 这条同时钉住"`typeof` 兜底没被删掉"：少了它，这个模块在 jest 里
    // import 的那一刻就 ReferenceError（不是运行时才炸）。
    expect(BUILD_DEFAULT_DEMO).toBe(false);
  });
});

describe('pickTransport', () => {
  it('两种模式各给一个**不同**的函数（别把两者写成都走远端）', () => {
    expect(pickTransport('server')).toBe(runAgent);
    expect(pickTransport('demo')).toBe(runAgentLocally);
    expect(pickTransport('server')).not.toBe(pickTransport('demo'));
  });
});

describe('toRunAgentInput', () => {
  const base = (over: Partial<RunRequest> = {}): RunRequest => ({
    threadId: 't1',
    runId: 'r1',
    messages: [{ id: 'm1', role: 'user', content: '看看工艺图' }],
    ...over,
  });

  it('补齐协议要求的字段', () => {
    const input = toRunAgentInput(base()) as any;
    expect(input.threadId).toBe('t1');
    expect(input.runId).toBe('r1');
    expect(input.messages).toHaveLength(1);
    // 这三个是协议要求的：state 是"画面上现在是什么"，tools/forwardedProps 可以空
    expect(input.state).toEqual({});
    expect(input.context).toEqual([]);
    expect(input.tools).toEqual([]);
    expect(input.forwardedProps).toEqual({});
  });

  it('给了 state / context 就原样带上', () => {
    const state = { chart: { kind: 'bar' } };
    const context = [{ description: 'ice-dsl-diagnostics', value: '坏了' }];
    const input = toRunAgentInput(base({ state, context })) as any;
    expect(input.state).toBe(state);
    expect(input.context).toBe(context);
  });

  it('★ resume 为空数组时**不带这个字段**', () => {
    // 空数组在协议里合法，但语义多余 —— "没有中断要回复"和"回复了 0 条"
    // 不该长得一样。带上还会让服务端多做一次"这条对应哪个中断"的查找。
    const input = toRunAgentInput(base({ resume: [] })) as any;
    expect('resume' in input).toBe(false);
  });

  it('★ resume 非空时原样带上（中断恢复就靠它）', () => {
    const resume = [{ interruptId: 'confirm-params', status: 'resolved' as const, payload: { a: 1 } }];
    const input = toRunAgentInput(base({ resume })) as any;
    expect(input.resume).toEqual(resume);
  });

  it('resume 没给时也不带（而不是给个 undefined）', () => {
    const input = toRunAgentInput(base()) as any;
    expect('resume' in input).toBe(false);
  });

  it('state 显式给 null 时落回 {}（null 不是合法 state）', () => {
    const input = toRunAgentInput(base({ state: null })) as any;
    expect(input.state).toEqual({});
  });
});

/**
 * 两个 transport 的**行为约定必须一致** —— 否则换一路走，上层错误处理
 * 会看到不一样的世界。这里只钉"能测得到的那部分"（真事件流在 e2e 里）。
 */
describe('两个 transport 的约定一致', () => {
  it('都是 `(request, handlers, signal) => Promise<void>` 形状', () => {
    for (const [name, t] of [
      ['remote', runAgent],
      ['local', runAgentLocally],
    ] as const) {
      expect({ name, isFn: typeof t === 'function' }).toEqual({ name, isFn: true });
      // 三个形参：request / handlers / signal（可选也算，所以用 >= 2 兜）
      expect({ name, ok: t.length >= 2 }).toEqual({ name, ok: true });
    }
  });

  it('★ 取消（AbortError）**不算错误** —— 两路都不调 onError', async () => {
    const controller = new AbortController();
    controller.abort();

    for (const [name, transport] of [
      ['local', runAgentLocally],
      ['remote', runAgent],
    ] as const) {
      const errors: Error[] = [];
      await transport(
        {
          threadId: 't',
          runId: 'r',
          messages: [{ id: 'm', role: 'user', content: 'x' }],
        },
        { onEvent: () => {}, onError: (e) => errors.push(e) },
        controller.signal
      );
      expect({ name, errors: errors.length }).toEqual({ name, errors: 0 });
    }
  });
});
