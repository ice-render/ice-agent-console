/**
 * 把各层接起来。
 *
 * 这个文件只做三件事，**没有业务逻辑**：
 *   1. 把动作分发给归约器；
 *   2. 执行归约器吐出来的 effects（碰 canvas 的脏活在这儿）；
 *   3. 把上行事件（用户输入、图上交互）翻译成新的 run。
 *
 * 有一点值得注意：`pendingDiagnostics` 是**渲染端发现的问题**，
 * 它不属于协议状态，但必须跨轮存活——所以要放在归约器外面。
 * 这是"纯核心 + 命令式外壳"模式下必然会出现的边界状态，放在这里比塞进 state 诚实。
 */
import {
  DSL_DIAGNOSTICS_CONTEXT_KEY,
  VIEW_INTERACTION_CONTEXT_KEY,
  DSL_TOOL_CONTEXT_KEY,
} from '../../shared/contract';
import { runAgent, apiUrl, type ResumeEntry } from '../domain/agui/client';
import { installTheme } from '../domain/theme';
import {
  initialState,
  reduce,
  type Action,
  type Effect,
  type TextItem,
} from '../domain/agui/reducer';
import { ThreadView } from '../view/thread';
import type { WidgetAction } from '../view/widget-layer';

// ---------------------------------------------------------------------------
// DOM 抓手
// ---------------------------------------------------------------------------

const threadEl = document.getElementById('thread');
const metaEl = document.getElementById('meta');
const formEl = document.getElementById('composer') as HTMLFormElement | null;
const inputEl = document.getElementById('input') as HTMLTextAreaElement | null;
const sendEl = document.getElementById('send') as HTMLButtonElement | null;
const chipsEl = document.getElementById('chips');

if (!threadEl || !metaEl || !formEl || !inputEl || !sendEl || !chipsEl) {
  throw new Error('页面骨架缺失：public/index.html 里的元素 id 跟 boot.ts 对不上');
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

// **主题必须在任何组件构造之前装** —— 库的主题是"组件构造时读一次"。
// 放这儿而不是放进 `main.ts`：这里就是"第一个会造组件的地方"的上游。
installTheme();

const threadId = `thread_${Math.random().toString(36).slice(2, 10)}`;
let state = initialState(threadId);
let running = false;

/** 渲染端诊断。跨轮存活，所以要放在归约器外面。 */
let pendingDiagnostics: string | null = null;

/**
 * 这一轮失败的是哪个工具（`render_chart` / `collect_input` / `render_diagram`）。
 *
 * 与 `pendingDiagnostics` 同生命周期：诊断说"哪里错了"，这个说"什么东西错了"。
 * 修复轮据此吐回同一种卡片。
 */
let failedTool: string | null = null;
/** 自修复只自动重试一次，避免"诊断永远修不好"时无限打转。 */
let autoRepairUsed = false;

// ---------------------------------------------------------------------------
// 渲染 + effects
// ---------------------------------------------------------------------------

/**
 * 卡片底部控件条上的按钮。
 *
 * 三个都走 AG-UI 上行（点一下触发新一轮 run），因为这里要证明的正是
 * **第二块画布是活的、能参与协议回路**，不是一张图片。它们跟图上点击/框选
 * 走同一条 `context` 通道，只是 kind 不同。
 */
const WIDGET_ACTIONS: WidgetAction[] = [
  { id: 'explain', text: '解释这张图', variant: 'primary' },
  { id: 'redraw', text: '换个画法' },
  { id: 'stream', text: '看实时数据' },
];

/** 控件动作 → 送给 agent 的一句话。 */
const WIDGET_PROMPTS: Record<string, string> = {
  explain: '解释一下这张图',
  redraw: '换个画法',
  stream: '看一下实时吞吐量',
};

const view = new ThreadView(
  threadEl,
  {
    onItemClick: (p) => {
      // 上行第 1 种：用户点了一个数据点。这正是"点击触发"的入口——
      // 没有对话面也可以跑 run，AG-UI 只规范 run 内部，不管 run 由谁触发。
      void send(`我点了「${p.xValue}」这个点，这里为什么是这样？`, {
        interaction: { kind: 'item-click', ...p },
      });
    },
    onBrushEnd: (range) => {
      // 上行第 2 种：用户框选了一段区间。
      // 结构化数据走 context，而不是塞进用户说的话里——两者语义不同，不该糊在一起。
      const span = range?.x ? `${range.x[0]} ~ ${range.x[1]}` : '一段区间';
      void send(`我框选了 ${span}，这里为什么波动？`, {
        interaction: { kind: 'brush', range },
      });
    },
  },
  {
    widgets: {
      // 图表卡的控件条（第二块画布）
      actions: WIDGET_ACTIONS,
      // 上行第 3 种：**canvas 控件**上的点击。
      // 前两种来自图表那张画布，这一种来自控件条那张 —— 两个 ICE 实例、两张画布，
      // 走的是同一条协议通道。
      onAction: (actionId) => {
        void send(WIDGET_PROMPTS[actionId] ?? actionId, {
          interaction: { kind: 'widget-action', action: actionId },
        });
      },
    },

    /**
     * 表单卡提交 —— **这条就是 AG-UI 的人机回环**。
     *
     * 协议规定：恢复一个被中断的 run 的方式是**开一个新的 run**，并在 `resume` 里逐条应答
     * 所有仍打开的中断。所以这里不是"接着跑"，而是带着答案发起新一轮。
     */
    onFormSubmit: (values, toolCallId) => {
      const pending = state.interrupt;
      dispatch({ type: '@local/form-submitted', toolCallId });
      view.card(toolCallId)?.markFormSubmitted();

      const summary = Object.entries(values)
        .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('/') : value}`)
        .join(', ');
      void send(`（已提交表单：${summary}）`, {
        ...(pending
          ? {
              resume: [{ interruptId: pending.id, status: 'resolved' as const, payload: values }],
            }
          : {}),
      });
    },
  }
);

function dispatch(action: Action): void {
  const { state: next, effects } = reduce(state, action);
  state = next;

  // 先渲染再执行 effects：mount 需要用渲染阶段创建出来的 canvas 元素
  view.render(state);

  const feedback = applyEffects(effects);
  if (feedback !== null) {
    // 两件事都要做，少一件回路就是断的：
    //   1. 写进归约状态（界面要能显示"校验没通过"）
    //   2. 记到 pendingDiagnostics（下一轮 run 要把它塞进 context 送给 agent）
    // 第一版只做了 1，结果自修复那一轮从来没被触发过——e2e 才把它逼出来。
    pendingDiagnostics = feedback;
    state = reduce(state, { type: '@local/diagnostics', text: feedback }).state;
  }

  updateMeta();
}

/** 执行 effects。返回本轮新产生的诊断文本（如果有）。 */
function applyEffects(effects: Effect[]): string | null {
  let diagnostics: string | null = null;

  for (const effect of effects) {
    switch (effect.type) {
      case 'mount-chart': {
        const card = view.card(effect.toolCallId);
        const result = card?.mount(effect.dsl);
        if (result && !result.ok) {
          diagnostics = result.diagnostics;
          // 记下是哪种卡失败了：修复轮要吐回同一种形态（见 shared/contract.ts 的
          // DSL_TOOL_CONTEXT_KEY）。不记的话「图 DSL 写错了」会被修成一张柱状图。
          failedTool = card?.tool ?? null;
        }
        break;
      }
      case 'append-rows': {
        const card = view.card(effect.toolCallId);
        if (!card) break;
        if (!card.appendRows(effect.rows)) {
          // 快路径判不了（比如类目轴要补 xAxis.data）→ 退回全量重绘。
          // 慢一点但一定对，这比"看起来更快但偶尔画错"强。
          if (state.sharedState?.chart) card.mount(state.sharedState.chart);
        }
        break;
      }
      case 'point-at': {
        // 「指着讲」：作用在最后一张活着的图表卡片上
        view.lastCard()?.pointAt(effect.value);
        break;
      }
      case 'clear-point': {
        view.lastCard()?.clearPoint();
        break;
      }
      default:
        break;
    }
  }

  return diagnostics;
}

function updateMeta(): void {
  const charts = state.items.filter((i) => i.kind === 'tool' && i.status !== 'streaming').length;
  const status =
    state.status === 'running'
      ? '运行中'
      : state.status === 'waiting'
        ? '等待作答'
        : state.status === 'error'
          ? '出错'
          : '空闲';
  metaEl!.innerHTML =
    `thread <b>${state.threadId.slice(-6)}</b> · ` +
    `事件 <b>${state.eventCount}</b> · ` +
    `卡片 <b>${charts}</b> · ` +
    `<b>${status}</b>` +
    (state.error ? ` · ${state.error}` : '');
}

// ---------------------------------------------------------------------------
// 跑一次 run
// ---------------------------------------------------------------------------

interface SendOptions {
  /** 图上交互产生的结构化上下文。 */
  interaction?: Record<string, any>;
  /** 这是自修复的自动重试，不要再插一条用户气泡。 */
  auto?: boolean;
  /** 对上一轮中断的答复。协议规定恢复中断 = 开新 run + 带上它。 */
  resume?: ResumeEntry[];
}

async function send(text: string, options: SendOptions = {}): Promise<void> {
  if (running) return;

  if (!options.auto) {
    dispatch({ type: '@local/user-message', text });
    autoRepairUsed = false;
  }

  running = true;
  sendEl!.disabled = true;
  updateMeta();

  // context 是 AG-UI 留给应用扩展的通道。这里装两样东西：
  // 上一轮渲染端的诊断（自修复用）、用户在图上做的事（追问用）。
  const context: Array<{ description: string; value: string }> = [];
  if (pendingDiagnostics) {
    context.push({ description: DSL_DIAGNOSTICS_CONTEXT_KEY, value: pendingDiagnostics });
    if (failedTool) {
      context.push({ description: DSL_TOOL_CONTEXT_KEY, value: failedTool });
    }
    pendingDiagnostics = null;
    failedTool = null;
  }
  if (options.interaction) {
    context.push({
      description: VIEW_INTERACTION_CONTEXT_KEY,
      value: JSON.stringify(options.interaction),
    });
  }

  const messages = state.items
    .filter((item): item is TextItem => item.kind === 'text')
    .map((item) => ({ id: item.id, role: item.role, content: item.text }));

  const runId = `run_${Date.now().toString(36)}`;

  try {
    await runAgent(
      {
        threadId,
        runId,
        messages,
        state: state.sharedState ?? {},
        context,
        ...(options.resume ? { resume: options.resume } : {}),
      },
      {
        onEvent: (event) => dispatch(event),
        onError: (err) => dispatch({ type: 'RUN_ERROR', message: err.message }),
      }
    );
  } finally {
    running = false;
    sendEl!.disabled = false;
  }

  // 自修复回路：这一轮渲染端报了错，就带着诊断自动再来一次。
  // 脚本化阶段就把这条回路走通，M2 换成真模型时这一段的代码一行都不用动。
  if (pendingDiagnostics && !autoRepairUsed) {
    autoRepairUsed = true;
    await send('', { auto: true });
    return;
  }

  updateMeta();
}

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------

const CHIPS = [
  '看看污水处理工艺图',
  '看看各渠道的月度销量',
  '看一下实时吞吐量',
  '要下发指令',
  '看看新控件都能用吗',
  '故意画错',
  '故意画错工艺图',
  '今天天气怎么样',
];

for (const text of CHIPS) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  chip.textContent = text;
  chip.addEventListener('click', () => void send(text));
  chipsEl.append(chip);
}

formEl.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  inputEl.style.height = '';
  void send(text);
});

inputEl.addEventListener('keydown', (event) => {
  // Enter 发送，Shift+Enter 换行
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    formEl.requestSubmit();
  }
});

window.addEventListener('resize', () => view.resizeAll());

/**
 * 把归约后的状态挂出来。
 *
 * 这不是"为测试而加的钩子"——这是个控制台，SSE 流是看不见摸不着的，
 * 没有它就只能靠猜"现在到底收到了什么"。调试价值是主要的，e2e 能断言协议层
 * 的状态（而不是只能断言像素）是顺带的好处。
 */
(globalThis as any).__iceAgentConsole = {
  getState: () => state,
  apiUrl: () => apiUrl(),
  /**
   * 最后一张卡片控件条上各按钮的矩形。
   * canvas 里没有 DOM 目标可定位，e2e 要点中某个按钮就得知道它画在哪。
   */
  widgetRects: () => view.lastCard()?.widgetRects() ?? [],
  /** 表单卡提交按钮的页面坐标。canvas 里没有 DOM 目标，e2e 要靠它点中。 */
  formSubmitPoint: () => view.lastFormCard()?.formSubmitPoint() ?? null,
  /** 往最后一张表单卡里写值。canvas 表单没法用 DOM 填，测试与调试需要这个口。 */
  fillForm: (values: Record<string, any>) => view.lastFormCard()?.fillForm(values) ?? false,
  /** 最后一张表单卡里各字段**画出来的文字**。用来断言占位文案真的落到了画布上。 */
  formFieldTexts: () => view.lastFormCard()?.formFieldTexts() ?? [],
  /** 最后一张表单卡里各字段的**值**。用来断言新类型真的进了取值回路。 */
  formValues: () => view.lastFormCard()?.formValues() ?? {},
  /**
   * 最后一张图卡的模型层事实：符号数 / 管线数 / 工艺校验问题。
   *
   * 为什么 e2e 需要它：canvas 里没有 DOM 目标，而"图对不对"是**模型层**的事实
   * （34 个符号、37 段管线、`validateWater()` 零问题）。只数像素证明不了数量对。
   */
  diagramStats: () => view.lastCard()?.diagramStats() ?? null,
  /** 最后一张图卡里被「指着讲」高亮的单元 id。 */
  diagramPointedId: () => view.lastCard()?.diagramPointedId() ?? null,
  /**
   * 最后一张图卡的视口与"内容画到屏幕哪儿了"。
   * canvas 里没有 DOM 目标，"有没有被裁到框外"只能靠它算。
   */
  diagramViewport: () => view.lastCard()?.diagramViewport() ?? null,
};

inputEl.focus();
updateMeta();
