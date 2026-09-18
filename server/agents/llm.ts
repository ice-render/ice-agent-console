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
import { DSL_DIAGNOSTICS_CONTEXT_KEY, VIEW_INTERACTION_CONTEXT_KEY, COLLECT_INPUT_TOOL, RENDER_CHART_TOOL, STATE_CHART_KEY, STATE_FORM_KEY,
  RENDER_DIAGRAM_TOOL,
  STATE_DIAGRAM_KEY,
} from '../../shared/contract';
import { planToEvents, type AnyEvent, type ToolCardPlan } from './dsl-to-events';
import { chatStream, type ChatMessage, type ChatResult, type ToolCall } from './llm-client';
import AsyncEventQueue from './stream-queue';
import { REPAIR_HINT, SYSTEM_PROMPT, TOOL_DEFINITIONS } from './tools';
import type { AgentRun } from './types';
import { DEFAULT_PACE, lastUserMessage, delayFor, type Pace } from './scripted';
import { EventType } from '@ag-ui/core';
import { EVT_REASONING } from '../../shared/contract';

/** 前端按工具名分派卡片，所以这些名字必须与协议层的定义一致。 */
const POINT_AT_TOOL = 'point_at';
const ZOOM_VIEW_TOOL = 'zoom_view';

/**
 * **画完之后**才允许模型调的工具（"看图说话"那一类）。
 *
 * 单独列出来是因为第二次调用**不能**放开 `render_*`：给了它就会接着又画一张，
 * 变成没完没了地画图。这两个不改图、只动镜头与高亮，所以放得开。
 */
const POST_RENDER_TOOLS = [POINT_AT_TOOL, ZOOM_VIEW_TOOL];

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
 * 读模型给的缩放指令。方向非法就当没给（不编一个默认方向出来 ——
 * 那会让"模型说了个没用的方向"变成"画面莫名其妙动了一下"）。
 */
/**
 * 把模型给的 `anchor` 归一成 `{ value, label? }`；认不出来就返回 null。
 *
 * 容忍两种写法（都是实测里真会出现的）：
 * - `"codAnalyzer"` —— 直接给一个字符串；
 * - `{ value | id | unit | tag, label? }` —— 给一个对象，键名各写各的。
 */
function normalizeAnchor(raw: any): { value: string; label?: string } | null {
  if (typeof raw === 'string') {
    const value = raw.trim();
    return value ? { value } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const value = raw.value ?? raw.id ?? raw.unit ?? raw.tag;
  if (typeof value !== 'string' || !value.trim()) return null;
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined;
  return { value: value.trim(), ...(label ? { label } : {}) };
}

function readZoomCommand(call: { name: string; args: any } | null | undefined): {
  direction: 'in' | 'out' | 'reset';
  factor?: number;
  steps?: number;
} | null {
  if (!call || call.name !== ZOOM_VIEW_TOOL) return null;
  const direction = call.args?.direction;
  if (direction !== 'in' && direction !== 'out' && direction !== 'reset') return null;
  const factor = Number(call.args?.factor);
  const steps = Number(call.args?.steps);
  return {
    direction,
    ...(Number.isFinite(factor) && factor > 0 ? { factor } : {}),
    ...(Number.isFinite(steps) && steps > 0 ? { steps: Math.floor(steps) } : {}),
  };
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
  // 名字 → {工具, stateKey} 的映射表，**不是**二元分支。
  // 写成 `isForm ? 表单 : 图表` 的话，模型调 `render_diagram` 会被当成图表卡渲染
  // —— 卡片类型错了、stateKey 也错，而两次都"看起来成功了"，最难查的那种。
  // 只列**会画卡片**的工具。`point_at` / `zoom_view` 是画完之后的动作，由第二次调用处理，
  // 不在这里（它们不产生卡片，落到下面的兜底分支也只会被当成图表卡）。
  const TOOL_ROUTES: Record<string, { tool: string; stateKey: string }> = {
    [COLLECT_INPUT_TOOL]: { tool: COLLECT_INPUT_TOOL, stateKey: STATE_FORM_KEY },
    [RENDER_DIAGRAM_TOOL]: { tool: RENDER_DIAGRAM_TOOL, stateKey: STATE_DIAGRAM_KEY },
    [RENDER_CHART_TOOL]: { tool: RENDER_CHART_TOOL, stateKey: STATE_CHART_KEY },
  };
  // 认不出来的工具名按图表卡兜底：与加图卡之前的行为一致（模型偶尔会编工具名）
  const route = TOOL_ROUTES[call.name] ?? TOOL_ROUTES[RENDER_CHART_TOOL];
  const tool = route.tool;
  const stateKey = route.stateKey;

  // ---- 第二次调用的产出：结论（可能顺带指着某个点 / 缩放视图）----
  const beats: ToolCardPlan['beats'] = [];
  if (second) {
    const call2 = second.toolCall;
    const pointAt =
      call2?.name === POINT_AT_TOOL && typeof call2.args?.xValue === 'string' ? call2.args.xValue : undefined;
    // blink 只在同时有 pointAt 时才有意义（闪的前提是已经指到某处）
    const blink = pointAt !== undefined && call2?.args?.blink === true;
    const zoom = readZoomCommand(call2);
    const text = second.text.trim();
    if (text || pointAt || zoom) {
      beats.push({
        text,
        ...(pointAt ? { pointAt } : {}),
        ...(blink ? { blink: true } : {}),
        ...(zoom ? { zoom } : {}),
      });
    }
  }
  if (!beats.length) {
    beats.push({ text: isForm ? '填好点提交，我拿到参数就继续。' : '画好了。' });
  }

  /**
   * **锚定**：模型可以在参数顶层给一个 `anchor`，说明这张卡片关联工艺图上的哪个单元。
   *
   * 两件事都必须在**进渲染之前**做完：
   * ① 摘出来（`payload` 里不能留）—— DSL 校验只认它自己的字段，多一个键会被判不合法，
   *    然后走成"自修复"，把一张本来好好的卡片修没；
   * ② 认不出的形状当没给 —— 宁可少一层"图上指回去"的呼应，也不要带着半个锚定往下走。
   */
  const anchor = normalizeAnchor((call.args as any)?.anchor);
  const payload =
    call.args && typeof call.args === 'object' && 'anchor' in (call.args as any)
      ? (() => {
          const rest = { ...(call.args as any) };
          delete rest.anchor;
          return rest;
        })()
      : call.args;

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
    payload,
    stateKey,
    ...(intro ? { intro } : {}),
    beats,
    ...(anchor ? { anchor } : {}),
    ...(interrupt ? { interrupt } : {}),
  } as ToolCardPlan;
}

export class LlmAgent implements AgentRun {
  constructor(
    private readonly llm: LlmConfig,
    private readonly pace: Pace = DEFAULT_PACE
  ) {}

  async *run(input: RunAgentInput, signal?: AbortSignal): AsyncIterable<AnyEvent> {
    // 前端在收到 RUN_STARTED 的那一刻就该进 running（那一行「正在思考」靠它出现），
    // 所以它必须在**调模型之前**发出去 —— 本地模型首答可能一两分钟。
    yield { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId, timestamp: Date.now() };

    const messages = this.buildMessages(input);

    // ---- 第 1 次：让它选（流式：思考与正文都边生成边发）----
    const first = yield* this.__streamCall(messages, TOOL_DEFINITIONS, 0, input.runId, signal);
    if (signal?.aborted) return;

    // ---- 第 2 次：回灌工具结果，拿"画完之后的那句话"（同样流式）----
    let second: ChatResult | null = null;
    let streamedAny = first.streamed;
    if (first.result.toolCall) {
      const toolCall = {
        id: first.result.toolCall.id,
        type: 'function' as const,
        function: { name: first.result.toolCall.name, arguments: first.result.toolCall.argsRaw || '{}' },
      };
      const post = yield* this.__streamCall(
        [
          ...messages,
          { role: 'assistant', content: first.result.text || null, tool_calls: [toolCall] },
          {
            role: 'tool',
            tool_call_id: first.result.toolCall.id,
            content: '{"status":"rendered","note":"已交给渲染端"}',
          },
        ],
        // 第二次只给"看图说话"那一类工具：这一步要的是一句话 + 可选的动作。
        // 放开 `render_*` 会让它接着又画一张，变成没完没了地画图。
        TOOL_DEFINITIONS.filter((t) => POST_RENDER_TOOLS.includes(t.function.name)),
        1,
        input.runId,
        signal
      );
      second = post.result;
      streamedAny = streamedAny || post.streamed;
      if (signal?.aborted) return;
    }

    // 计划本身仍然是那份纯函数（工具选择 → 卡片载荷 / 动作 / 中断），流式只改变"文字从哪来"：
    // 已经流过的正文不再重发，卡片与动作照旧按同一套节奏走。
    const plan = buildLlmPlan(
      { text: first.result.text, toolCall: first.result.toolCall },
      second ? { text: second.text, toolCall: second.toolCall } : null,
      input.runId
    );
    const events = planToEvents(plan, { threadId: input.threadId, runId: input.runId }, {
      streamedText: streamedAny,
      skipRunStarted: true,
    });
    // 卡片 / 动作的节奏与剧本模式**完全同一条路**（同一个 `delayFor`）。
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

  /** 把 AG-UI 的输入拼成模型的消息表（两条路径共用）。 */
  private buildMessages(input: RunAgentInput): ChatMessage[] {
    const notes = contextNotes(input);
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      ...toChatMessages(input),
      ...(input.state && Object.keys(input.state).length
        ? [{ role: 'user' as const, content: `【当前画布状态】${JSON.stringify(input.state)}` }]
        : []),
      ...notes.map((content) => ({ role: 'user' as const, content })),
    ];
  }

  /**
   * 流式调一次模型，把"推"出来的增量立刻变成事件 `yield` 出去，最后返回完整结果。
   *
   * 为什么要队列：`onDelta` 是回调（推），而 `run()` 是生成器（拉）——
   * JS 里不能从回调里 `yield`。`AsyncEventQueue` 就是这两者中间的接缝，
   * 见它的文件头。
   *
   * 结束时要**补一条 TEXT_MESSAGE_END**：正文是分片来的，长度事先不知道，
   * 只能等这一次调用收完再收口（前端的归约器靠 END 把这一条标成 `done`）。
   */
  private async *__streamCall(
    messages: ChatMessage[],
    tools: unknown[],
    phase: number,
    runId: string,
    signal?: AbortSignal
  ): AsyncGenerator<AnyEvent, { result: ChatResult; streamed: boolean }> {
    const queue = new AsyncEventQueue<AnyEvent>();
    // 消息 id 带上 runId 与 phase：跨轮、跨段都不能撞（撞了前端会复用同一条气泡）
    const messageId = `msg_${runId}_s${phase}`;
    let opened = false;
    let streamed = false;

    const openText = () => {
      if (opened) return;
      opened = true;
      queue.push({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant', timestamp: Date.now() });
    };

    const task = chatStream(this.llm, messages, tools, signal, {
      onReasoning: (delta) => {
        // 思考过程走 CUSTOM：它不是对话的一条消息，而是"这一轮正在发生什么"的过程事实。
        // 前端按 phase 聚合成一条，正文一开始就自动收起。
        queue.push({
          type: EventType.CUSTOM,
          name: EVT_REASONING,
          value: { delta, phase },
          timestamp: Date.now(),
        });
      },
      onContent: (delta) => {
        streamed = true;
        openText();
        queue.push({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta,
          timestamp: Date.now(),
        });
      },
    });

    const settle = (fn: () => void) => {
      if (opened) {
        queue.push({ type: EventType.TEXT_MESSAGE_END, messageId, timestamp: Date.now() });
        opened = false;
      }
      fn();
    };
    task.then(
      () => settle(() => queue.close()),
      (err) => {
        // 取消不算错（页面关掉 / 用户打断）：静默收尾，别报一条 RUN_ERROR 吓人。
        // 这条与剧本模式的取消语义一致，见 AGENTS「两条 transport 的取消语义也要一致」。
        if (signal?.aborted || (err && (err as Error).name === 'AbortError')) {
          settle(() => queue.close());
          return;
        }
        settle(() => queue.fail(err));
      }
    );

    for await (const event of queue) {
      yield event;
    }
    // 到这里队列已经收口：错误（如果有）在这里抛出，交给 index.ts 变成 RUN_ERROR
    const result = await task;
    return { result, streamed };
  }

  /**
   * 「读输入 → 决定做什么」这一步（旧的非流式实现）。
   *
   * 现在由 `run()` 里的两次 `__streamCall` + `buildLlmPlan` 承担 ——
   * 这里**刻意不留**一份"不流式的老路"：两条路并存迟早会漂，
   * 而漂的那一侧恰好是平时没人跑的那条。
   */
}
