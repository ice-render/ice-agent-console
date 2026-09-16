/**
 * **浏览器内的 transport**：在页面里直接跑那份剧本 agent，不连后端。
 *
 * ## 为什么能在浏览器里跑（这不是"又写了一个 mock"）
 *
 * `ScriptedAgent` 本来就是**纯代码** —— 它只依赖 `@ag-ui/core` 与 `shared/`，
 * 整条依赖链上没有一处 node-only API（唯一的平台调用是 `setTimeout` / `AbortSignal`，
 * 浏览器与 Node 都有）。所以"mock 服务端"这件事不需要重写一遍：
 * 把同一个实例搬进页面里跑，事件流一模一样。
 *
 * 这一点是整条演示模式的价值所在：**剧本、事件序列、节奏、自修复回路全是同一份代码**，
 * 两侧不会漂。哪天 `scenarios.ts` 改了，演示站点跟着变 —— 不需要人记得去同步。
 *
 * ## 与远端那一路的约定必须一致
 *
 * 尤其是**取消语义**：`signal` abort 之后静默返回、**不当成错误上报**。
 * 换 transport 不该让上层的错误处理看到不一样的世界
 * （远端那一路见 `client.ts` 的 `AbortError` 分支）。
 *
 * ## ⚠️ 只许依赖那几个"纯文件"
 *
 * `server/agents/` 里**只有四个**是能在浏览器里跑的：
 * `scripted.ts` / `scenarios.ts` / `dsl-to-events.ts` / `types.ts`。
 * 同目录的 `llm.ts` / `llm-client.ts` / `tools.ts` 与上层的 `index.ts` / `config.ts`
 * 是真 node-only（`node:http` / `fs` / `process.env`），**碰了就会把浏览器包搞坏**
 * —— 而且症状是打包期报一堆 node polyfill 找不到，或者打出一个巨大的假包。
 *
 * 这一条在 `AGENTS.md` 里是硬约束。
 */
import { DEFAULT_PACE, ScriptedAgent } from '../../../server/agents/scripted';
import { toRunAgentInput, type RunHandlers, type RunRequest } from './run-input';

/**
 * 跑一次 run（浏览器内），事件按到达顺序交给 `onEvent`。
 *
 * 每次调用新建一个 agent：它**不持有跨 run 的状态**（状态在 `input.state` 里传），
 * 所以复用实例没有收益，而每次新建能免掉"上一轮的 pace / 中断残留影响下一轮"这类隐患。
 *
 * 节奏用 `DEFAULT_PACE`（26ms/字）—— 那正是演示要的"看着它一段段写出来"的效果，
 * 与连后端时的观感完全一致。**没有**做"演示模式就加速"这种事：
 * 加速会让演示站点看起来与真环境不一样，而它存在的意义恰恰是"看起来一模一样"。
 */
export async function runAgentLocally(
  request: RunRequest,
  handlers: RunHandlers,
  signal?: AbortSignal
): Promise<void> {
  const agent = new ScriptedAgent(DEFAULT_PACE);

  try {
    for await (const event of agent.run(toRunAgentInput(request), signal)) {
      // agent 自己也会在每次 yield 前看 signal，这里再挡一道：拿到信号之后
      // 就别再往下游送事件了（下游可能已经在拆 DOM）
      if (signal?.aborted) break;
      handlers.onEvent(event);
    }
    handlers.onDone?.();
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return;
    handlers.onError?.(err as Error);
  }
}
