/**
 * agent 的对外接口。**这个接口是 M1 和 M2 的分界线。**
 *
 * M1 的实现是 `ScriptedAgent`（规则决策），M2 的实现会是 `LlmAgent`（模型决策）。
 * 两者产出的都是同一串 AG-UI 事件——前端的归约器和渲染层一行都不用改。
 *
 * 关键在于：真正跟"是不是 LLM"无关的部分（DSL → 含分片的事件序列）被抽到了
 * `dsl-to-events.ts`，两个实现共享。换 LLM 时，新增的代码只是"把自然语言变成 DSL"。
 */
import type { RunAgentInput } from '@ag-ui/core';
import type { AnyEvent } from './dsl-to-events';

export interface AgentRun {
  /**
   * 跑一次 run，产出有序的 AG-UI 事件流。
   *
   * 返回 AsyncIterable 而不是数组：真实 agent 是边想边吐的，
   * 而事件之间的**时间间隔**本身就是协议语义的一部分（用户要看着它一步步画出来）。
   */
  run(input: RunAgentInput, signal?: AbortSignal): AsyncIterable<AnyEvent>;
}
