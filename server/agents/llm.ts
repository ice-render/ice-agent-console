/**
 * M2 的 agent 实现：**让真模型来决定做什么**。
 *
 * ## 它与 `ScriptedAgent` 的分界线在哪
 *
 * 恰好在 `server/agents/types.ts` 承诺的位置：**唯一新增的代码是"把自然语言变成
 * `ToolCardPlan`"**。拿到计划之后，事件序列（`planToEvents`）、分片节奏、SSE 传输、
 * 前端归约与渲染 —— 一行都没有变，两个实现共用。
 *
 * 所以这个文件里能看到的东西很有限：把对话拼成模型的消息、调一次或两次模型、
 * 把模型的选择翻译成 `ToolCardPlan`。**没有一行事件代码**。
 *
 * ## 为什么要调**两次**模型
 *
 * 剧本里的卡片是这样一拍的：`先说一句 → 卡片 → 再讲一句（可以指着某个点）`。
 * 一次模型调用只能给一段文字，拼不出"前后各一句"。
 *
 * 第一次调用让它选工具（这时它通常不说话，直接调）；拿到工具调用之后，
 * 把**工具结果回灌**再调第二次，得到的才是"画完之后的结论"。这也是真实 agent 的
 * 循环形状 —— 只不过这里只有一圈。
 *
 * `point_at` 也发生在第二次：模型可以在给结论的同时指出它要讲的那个点。
 *
 * ## 出错时不悄悄退回剧本
 *
 * 401 / 404 / 超时都会**原样抛出去**，服务端会把它变成 `RUN_ERROR` 事件，
 * 界面上是一条红色气泡，里面是接口的真实报错。理由：配错了 token 而界面照常演剧本，
 * 人会以为"配好了"，实际一直在看假的。宁可红一次，也不静默降级。
 * （启动横幅里也会写明这一轮到底是哪种模式。）
 */
import type { RunAgentInput } from '@ag-ui/core';
import type { LlmConfig } from '../config';
import { DSL_DIAGNOSTICS_CONTEXT_KEY, VIEW_INTERACTION_CONTEXT_KEY, COLLECT_INPUT_TOOL, RENDER_CHART_TOOL, STATE_CHART_KEY, STATE_FORM_KEY } from '../../shared/contract';
import { planToEvents, type AnyEvent, type ToolCardPlan } from './dsl-to-events';
import { chat, type ChatMessage } from './llm-client';
import { REPAIR_HINT, SYSTEM_PROMPT, TOOL_DEFINITIONS } from './tools';
import type { AgentRun } from './types';
import { DEFAULT_PACE, lastUserMessage, delayFor, type Pace } from './scripted';

/** 前端按工具名分派卡片，所以这两个名字必须与协议层的定义一致。 */
const POINT_AT_TOOL = 'point_at';

/** 把 AG-UI 的消息历史转成模型要的形状。 */
function toChatMessages(input: RunAgentInput): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of (input.messages ?? []) as any[]) {
    if (m?.role === 'user') {
      const content =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((p: any) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('')
            : '';
      if (content) out.push({ role: 'user', content });
    } else if (m?.role === 'assistant' && typeof m.content === 'string' && m.content) {
      // 历史里的助手发言只有文字 —— 上一轮的 tool_call 不在客户端回传的 messages 里
      // （客户端只发文字消息），所以这里不补 tool_calls，模型靠 `state` 知道画面上有什么。
      out.push({ role: 'assistant', content: m.content });
    }
  }
  return out;
}

/**
 * 把 `context` 里那两条**扩展通道**翻译成模型能读的一段话。
 *
 * 协议里 `context` 是 `{description, value}` 的数组，本来就是留给应用扩展的。
 * 这里的两条语义完全不同，所以分开写：
 * - 诊断 —— 上一轮**渲染端报的错**，自修复回路靠它；
 * - 画布交互 —— 用户**刚才在图上做了什么**（点了哪个点、框了哪一段）。
 */
function contextNotes(input: RunAgentInput): string[] {
  const notes: string[] = [];
  for (const c of (input.context ?? []) as any[]) {
    if (c?.description === DSL_DIAGNOSTICS_CONTEXT_KEY) {
      notes.push(`${REPAIR_HINT}\n\n诊断：\n${typeof c.value === 'string' ? c.value : JSON.stringify(c.value, null, 2)}`);
    } else if (c?.description === VIEW_INTERACTION_CONTEXT_KEY) {
      const raw = typeof c.value === 'string' ? c.value : JSON.stringify(c.value);
      notes.push(
        `【用户在画布上做了动作】${raw}\n（这是结构化上下文，不是用户说的话 —— 请针对这个动作回应。）`
      );
    }
  }
  return notes;
}

/**
 * 一次模型调用 + 工具执行之后，攒出 `ToolCardPlan`。
 *
 * 拆成纯函数是为了能单测：喂进"模型的两次回复"，断言产出的计划长什么样。
 * 网络那一层（`chat`）单独测。
 */
export function buildLlmPlan(
  first: { text: string; toolCall: { name: string; args: any; id: string } | null },
  second: { text: string; toolCall: { name: string; args: any; id: string } | null } | null,
  runId: string
): ToolCardPlan {
  const call = first.toolCall;
  const intro = first.text.trim();

  // ---- 没调工具：纯文字回复 ----
  // 文字放 `beats` 而不是 `intro`：`intro` 的语义是"画之前先说一句"，
  // 而这里根本没有卡片。放错了会让前端的消息顺序看起来怪。
  if (!call) {
    return { beats: [{ text: intro || '（模型没有返回内容）' }] } as ToolCardPlan;
  }

  if (call.args === null) {
    // 模型给了一段解析不了的 JSON 参数 —— 如实说，别装作没事
    return {
      beats: [
        {
          text:
            `模型想调 \`${call.name}\`，但参数不是合法 JSON，没法渲染。\n` +
            `原文（前 200 字）：${String((call as any).argsRaw ?? '').slice(0, 200)}`,
        },
      ],
    } as ToolCardPlan;
  }

  const isForm = call.name === COLLECT_INPUT_TOOL;
  const tool = isForm ? COLLECT_INPUT_TOOL : RENDER_CHART_TOOL;
  const stateKey = isForm ? STATE_FORM_KEY : STATE_CHART_KEY;

  // ---- 第二次调用的产出：结论（可能顺带指着某个点）----
  const beats: ToolCardPlan['beats'] = [];
  if (second) {
    const pointAt =
      second.toolCall?.name === POINT_AT_TOOL && typeof second.toolCall.args?.xValue === 'string'
        ? second.toolCall.args.xValue
        : undefined;
    const text = second.text.trim();
    if (text || pointAt) {
      beats.push({ text, ...(pointAt ? { pointAt } : {}) });
    }
  }
  if (!beats.length) {
    beats.push({ text: isForm ? '填好点提交，我拿到参数就继续。' : '画好了。' });
  }

  // 表单卡 = 一次中断：**调 `collect_input` 就等于"我需要用户提供信息"**，
  // 而"需要用户提供信息"在协议里就是 interrupt。这条映射写在工具的 description 里，
  // 模型知道它调了这个就会停下来等。
  const interrupt = isForm
    ? {
        id: `collect-${call.id || runId}`,
        reason:
          (typeof call.args?.title === 'string' && call.args.title) ||
          (typeof call.args?.description === 'string' && call.args.description) ||
          '需要用户提供信息才能继续',
        ...(typeof call.args?.description === 'string' ? { message: call.args.description } : {}),
      }
    : undefined;

  return {
    tool,
    payload: call.args,
    stateKey,
    ...(intro ? { intro } : {}),
    beats,
    ...(interrupt ? { interrupt } : {}),
  } as ToolCardPlan;
}

export class LlmAgent implements AgentRun {
  constructor(
    private readonly llm: LlmConfig,
    private readonly pace: Pace = DEFAULT_PACE
  ) {}

  async *run(input: RunAgentInput, signal?: AbortSignal): AsyncIterable<AnyEvent> {
    const plan = await this.decide(input, signal);
    const events = planToEvents(plan, { threadId: input.threadId, runId: input.runId });
    // 事件序列与剧本模式**完全同一条路**：同一个 `planToEvents`、
    // 同一个 `delayFor` 节奏。所以"分片 / 停顿 / 收尾"的手感两边一致。
    for (let i = 0; i < events.length; i++) {
      if (signal?.aborted) return;
      const wait = delayFor(events[i], events[i + 1], this.pace);
      if (wait > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, wait);
          signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
      }
      if (signal?.aborted) return;
      yield events[i];
    }
  }

  /** 「读输入 → 决定做什么」这一步。返回的是与剧本模式同形的计划。 */
  private async decide(input: RunAgentInput, signal?: AbortSignal): Promise<ToolCardPlan> {
    const notes = contextNotes(input);

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...toChatMessages(input),
      // 把"现在画面上是什么"如实告诉模型：`state` 是协议的原生字段，
      // 客户端每轮都会回传（不然"换个画法"这类指令它没法做）
      ...(input.state && Object.keys(input.state).length
        ? [{ role: 'user' as const, content: `【当前画布状态】${JSON.stringify(input.state)}` }]
        : []),
      ...notes.map((content) => ({ role: 'user' as const, content })),
    ];

    // ---- 第 1 次：让它选 ----
    const first = await chat(this.llm, messages, TOOL_DEFINITIONS, signal);
    if (!first.toolCall) {
      return buildLlmPlan(first, null, input.runId);
    }

    // ---- 第 2 次：把工具结果回灌，拿"画完之后的那句话" ----
    const toolCall = {
      id: first.toolCall.id,
      type: 'function' as const,
      function: { name: first.toolCall.name, arguments: first.toolCall.argsRaw || '{}' },
    };
    const second = await chat(
      this.llm,
      [
        ...messages,
        { role: 'assistant', content: first.text || null, tool_calls: [toolCall] },
        {
          role: 'tool',
          tool_call_id: first.toolCall.id,
          // 工具"执行"在这一层就是渲染端的事 —— 服务端只确认它被接受了。
          // DSL 的值语义由客户端的 `validateFormDsl` / `validateChartDsl` 验，
          // 不通过会把诊断经 context 回灌，下一轮模型自己改（自修复回路）。
          content: '{"status":"rendered","note":"已交给渲染端"}' ,
        },
      ],
      // 第二次**不给它工具**：这一步只要一句话（以及可选的 point_at）。
      // 给了它就可能接着又调 render_chart，变成没完没了的画图。
      // 唯一的例外是 point_at —— "画完之后指着讲"要发生在这里。
      TOOL_DEFINITIONS.filter((t) => t.function.name === POINT_AT_TOOL),
      signal
    );

    return buildLlmPlan(first, second, input.runId);
  }
}
