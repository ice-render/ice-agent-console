/**
 * M1 的 agent 实现：**规则决策的确定性 agent**。
 *
 * 措辞上刻意不叫"模拟 LLM"。LLM 只是实现 agent 的一种方式；agent 的本体是
 * 「读输入 → 决定做什么 → 吐事件」。这里用规则实现本体，产出的事件流和真模型
 * 产出的完全一样——前端分辨不出来，也不需要分辨。
 *
 * 这个区分是实操性的：如果按"假装有个模型"来写，就会忍不住加随机延迟、
 * 假装思考停顿、让文字抖动得像在生成。那些全是伪装，只会引入没必要的非确定性，
 * 把 e2e 搞 flaky。这里是干净的确定性分支代码。
 */
import type { RunAgentInput } from '@ag-ui/core';
import { EventType } from '@ag-ui/core';
import { DSL_DIAGNOSTICS_CONTEXT_KEY, VIEW_INTERACTION_CONTEXT_KEY } from '../../shared/contract';
import { planToEvents, type AnyEvent } from './dsl-to-events';
import { buildPlan } from './scenarios';
import type { AgentRun } from './types';

/**
 * 播放节奏（毫秒）。
 *
 * 它**不属于事件序列**——`planToEvents` 是纯函数，只管"发什么、按什么顺序发"。
 * "每条之间停多久"是传输层的事，放这里。分开的好处是事件序列能被单测穷举断言，
 * 而节奏可以被 e2e 调成 0 让它跑快。
 */
export interface Pace {
  textChunk: number;
  toolArgs: number;
  phase: number;
}

export const DEFAULT_PACE: Pace = { textChunk: 26, toolArgs: 14, phase: 220 };
export const NO_PACE: Pace = { textChunk: 0, toolArgs: 0, phase: 0 };

/** 从消息里取出最后一条用户发言。content 在不同版本里可能是字符串或 parts 数组。 */
export function lastUserMessage(input: RunAgentInput): string {
  const messages = (input.messages ?? []) as any[];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((part: any) => (typeof part === 'string' ? part : part?.text ?? ''))
        .join('');
    }
    return '';
  }
  return '';
}

/**
 * 上一轮渲染端有没有回灌诊断。
 *
 * 这是自修复回路的入口：客户端 `validateChartDsl` 不通过时，会把结构化诊断挂在这条
 * context 上进下一轮 run。协议里没有"渲染端错误回传"的原生通道，`context` 就是给它准备的。
 */
export function readDiagnostics(input: RunAgentInput): string | null {
  const context = (input.context ?? []) as any[];
  const hit = context.find((c) => c?.description === DSL_DIAGNOSTICS_CONTEXT_KEY);
  if (!hit) return null;
  return typeof hit.value === 'string' ? hit.value : JSON.stringify(hit.value);
}

/**
 * 上一轮用户在图上做了什么（点了数据点 / 框选了一段）。
 *
 * 跟诊断走同一条 `context` 通道，但语义完全不同：诊断是**渲染端的错误反馈**，
 * 这个是人类**在画布上的动作**。放在一起是因为协议的扩展点只有一个，
 * 靠 `description` 区分。
 */
export function readInteraction(input: RunAgentInput): string | null {
  const context = (input.context ?? []) as any[];
  const hit = context.find((c) => c?.description === VIEW_INTERACTION_CONTEXT_KEY);
  if (!hit) return null;
  return typeof hit.value === 'string' ? hit.value : JSON.stringify(hit.value);
}

/**
 * 事件之间的停顿。按类型给不同时长——"文字在流"和"参数在拼"的手感不一样，
 * 分阶段事件（tool call 开始、结果、run 结束）之间多停一点，让人看得出步骤。
 */
export function delayFor(event: AnyEvent, next: AnyEvent | undefined, pace: Pace): number {
  if (pace.phase === 0 && pace.textChunk === 0) return 0;
  if (event.type === EventType.TEXT_MESSAGE_CONTENT) return pace.textChunk;
  if (event.type === EventType.TOOL_CALL_ARGS) return pace.toolArgs;
  if (event.type === EventType.RUN_FINISHED) return 0;
  // 分阶段的边界停久一点：文字讲完 → 开始画，画完 → 出图
  if (
    event.type === EventType.TEXT_MESSAGE_END ||
    event.type === EventType.TOOL_CALL_START ||
    event.type === EventType.TOOL_CALL_RESULT
  ) {
    return pace.phase;
  }
  return next ? 8 : 0;
}

export class ScriptedAgent implements AgentRun {
  constructor(private pace: Pace = DEFAULT_PACE) {}

  async *run(input: RunAgentInput, signal?: AbortSignal): AsyncIterable<AnyEvent> {
    // 五样输入一起交给剧本层。其中 resume 是协议原生的"对中断的答复"——
    // 有了它，这一轮就不是"用户又说了句话"，而是"上一轮那个口子被填上了"。
    const plan = buildPlan({
      message: lastUserMessage(input),
      hasDiagnostics: readDiagnostics(input) !== null,
      interaction: readInteraction(input),
      // state 让 agent 能读到"现在画面上是什么"，才能做"换个画法"这类事
      state: input.state,
      resume: (input as any).resume ?? null,
    });

    const events = planToEvents(plan, {
      threadId: input.threadId,
      runId: input.runId,
    });

    for (let i = 0; i < events.length; i++) {
      if (signal?.aborted) return;
      const wait = delayFor(events[i], events[i + 1], this.pace);
      if (wait > 0) await sleep(wait, signal);
      if (signal?.aborted) return;
      yield events[i];
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
