/**
 * 把各层接起来。
 *
 * 这个文件只做四件事，**没有业务逻辑**：
 *   1. 把动作分发给归约器；
 *   2. 执行归约器吐出来的 effects（碰 canvas 的脏活全在 `StageView` 里）；
 *   3. 把上行事件（用户输入、图上交互）翻译成新的 run；
 *   4. 布局：绘图区铺满视口、对话面板浮在右边、开页先把工艺图画上。
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
import { WATER_PROCESS_DSL } from '../../shared/water-process-case';
import { runAgent, apiUrl, type ResumeEntry } from '../domain/agui/client';
import { installTheme } from '../domain/theme';
import {
  initialState,
  reduce,
  type Action,
  type Effect,
  type TextItem,
} from '../domain/agui/reducer';
import { ChatView } from '../view/chat';
import { StageView, type StageMountResult } from '../view/stage';
import type { WidgetAction } from '../view/widget-layer';

// ---------------------------------------------------------------------------
// DOM 抓手
// ---------------------------------------------------------------------------

const stageEl = document.getElementById('stage');
const chatEl = document.getElementById('chat');
const chatToggleEl = document.getElementById('chat-toggle');
const threadEl = document.getElementById('thread');
const metaEl = document.getElementById('meta');
const formEl = document.getElementById('composer') as HTMLFormElement | null;
const inputEl = document.getElementById('input') as HTMLTextAreaElement | null;
const sendEl = document.getElementById('send') as HTMLButtonElement | null;
const chipsEl = document.getElementById('chips');
const collapseEl = document.getElementById('chat-collapse');

if (
  !stageEl ||
  !chatEl ||
  !chatToggleEl ||
  !threadEl ||
  !metaEl ||
  !formEl ||
  !inputEl ||
  !sendEl ||
  !chipsEl ||
  !collapseEl
) {
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
 * 修复轮据此吐回同一种图层。
 */
let failedTool: string | null = null;
/** 自修复只自动重试一次，避免"诊断永远修不好"时无限打转。 */
let autoRepairUsed = false;

// ---------------------------------------------------------------------------
// 绘图区 + 对话面板
// ---------------------------------------------------------------------------

/**
 * 控件条上的按钮。
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

const stage = new StageView(stageEl, {
  handlers: {
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
  widgets: {
    // 图表图层底部的控件条（第二块画布，浮在绘图区底部）
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
   * 表单提交 —— **这条就是 AG-UI 的人机回环**。
   *
   * 协议规定：恢复一个被中断的 run 的方式是**开一个新的 run**，并在 `resume` 里逐条应答
   * 所有仍打开的中断。所以这里不是"接着跑"，而是带着答案发起新一轮。
   */
  onFormSubmit: (values, toolCallId) => {
    const pending = state.interrupt;
    dispatch({ type: '@local/form-submitted', toolCallId });
    stage.markFormSubmitted();

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
});

const view = new ChatView(threadEl);

/**
 * 先让绘图区知道面板占了右边多少，**再**画图。
 *
 * 顺序是承重的：`DiagramLayer` 的初始视野**只设一次**，那一次就要按真实可视区算。
 * 反过来的话第一版视野会按整幅画布居中（图的中间落在面板底下），
 * 然后要靠一次 `reframe()` 纠正 —— 画面会闪一下，而且多算一遍。
 */
syncPanelInset();

/**
 * 开页就把工艺图画上。
 *
 * 这是布局反转的第一条需求（"一开始就显示工艺图"）的落点。放在 `installTheme()` 之后、
 * 任何 run 之前：绘图区是主体，它不该等用户说第一句话。
 *
 * 数据从 `shared/water-process-case.ts` 来 —— 放 `shared/` 的唯一原因就是这里：
 * 服务端写计划、前端画图，一份来源。
 */
if (stage.mount('render_diagram', WATER_PROCESS_DSL).ok) {
  updateMeta();
}

function dispatch(action: Action): void {
  const { state: next, effects } = reduce(state, action);
  state = next;

  // 先渲染再执行 effects：mount 要用渲染阶段创建出来的条目（hint 要写进去）
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
        const entry = view.entry(effect.toolCallId);
        const tool = entry?.tool ?? '';
        const result = stage.mount(tool, effect.dsl, effect.toolCallId);
        if (result.ok) {
          entry?.markMounted(hintFor(tool, effect.dsl, result));
          view.markActive(effect.toolCallId);
        } else {
          entry?.markFailed('校验不通过', result.diagnostics);
          // 记下是哪种图层失败了：修复轮要吐回同一种形态（见 shared/contract.ts 的
          // DSL_TOOL_CONTEXT_KEY）。不记的话「图 DSL 写错了」会被修成一张柱状图。
          failedTool = tool || null;
          diagnostics = result.diagnostics;
        }
        break;
      }
      case 'append-rows': {
        if (!stage.appendRows(effect.rows)) {
          // 快路径判不了（比如类目轴要补 xAxis.data）→ 退回全量重绘。
          // 慢一点但一定对，这比"看起来更快但偶尔画错"强。
          if (state.sharedState?.chart) {
            const result = stage.mount('render_chart', state.sharedState.chart);
            if (!result.ok) diagnostics = result.diagnostics;
          }
        }
        break;
      }
      case 'point-at': {
        // 「指着讲」：作用在绘图区**当前显示的那一层**上（工艺图走高亮，图表走悬停）
        stage.pointAt(effect.value, { blink: effect.blink === true });
        break;
      }
      case 'clear-point': {
        stage.clearPoint();
        break;
      }
      case 'zoom': {
        // 缩放视图：只有工艺图会响应（图表返回 false，静默）。这是"查看"动作，不是编辑。
        //
        // ⚠️ 每个可选字段都要**逐个转交**（`undefined` 不能进去）——
        // 有一次加 `scale` 时漏了这一行，结果是 `to` 命令到了视图层却没有目标倍率、
        // 被当作非法整条丢掉，症状是"讲稿里推镜头的那几拍画面纹丝不动"（而且不报错）。
        stage.zoomView({
          direction: effect.direction,
          ...(effect.factor !== undefined ? { factor: effect.factor } : {}),
          ...(effect.steps !== undefined ? { steps: effect.steps } : {}),
          ...(effect.scale !== undefined ? { scale: effect.scale } : {}),
        });
        break;
      }
      default:
        break;
    }
  }

  return diagnostics;
}

/**
 * 条目上的"去了哪儿"提示。
 *
 * 旧结构里这段话说的是"已编译为 N 个符号并挂到同一个实例上"——它在解释卡片里那块画布。
 * 现在那块画布在绘图区，所以要说清"东西在哪儿、怎么操作"。
 */
function hintFor(tool: string, dsl: unknown, result: StageMountResult): string {
  const bytes = JSON.stringify(dsl)?.length ?? 0;
  const kind = result.kind;

  if (kind === 'diagram') {
    const stats = stage.diagramStats();
    const counts = stats ? `<b>${stats.symbols}</b> 个符号、<b>${stats.pipes}</b> 段管线` : '一张工艺图';
    return (
      `参数共 <b>${bytes}</b> 字节，分片流式传完；${counts} 已画到<b>绘图区</b>` +
      (result.built ? '' : '（内容没变，直接复用原来那一层，<b>没有重绘</b>）') +
      '。滚轮缩放、空白处拖拽平移 —— <code>ice-entity-designer</code> 画的，不是图片。'
    );
  }

  if (kind === 'form') {
    return (
      `参数共 <b>${bytes}</b> 字节，分片流式传完；表单已画到<b>绘图区中央</b>` +
      `（<code>ice-web-components-dsl</code>，另一块画布、另一个 ICE 实例）。`
    );
  }

  return (
    `参数共 <b>${bytes}</b> 字节，分片流式传完；图表已画到<b>绘图区</b>，` +
    `底部那条控件栏是<b>另一张画布</b>（第二个 ICE 实例，由 <code>ice-web-components</code> 绘制）。`
  );
}

function updateMeta(): void {
  const info = stage.info();
  const tools = state.items.filter((i) => i.kind === 'tool' && i.status !== 'streaming').length;
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
    `绘图区 <b>${info.active ?? '空'}</b> · ` +
    `工具 <b>${tools}</b> · ` +
    `<b>${status}</b>` +
    (state.error ? ` · ${state.error}` : '');
}

// ---------------------------------------------------------------------------
// 布局：面板折叠 / 尺寸跟随
// ---------------------------------------------------------------------------

/**
 * 面板折叠时把右边让出来的宽度告诉绘图区。
 *
 * **实测而不是写死一个数**：面板宽度受字体、滚动条、`--chat-gap` 影响，
 * 在 JS 里重算一遍等于把 CSS 的盒子抄一份（改一次 CSS 就得改一次 JS）。
 * 直接拿"绘图区右边缘到面板左边缘的距离"就是它压住的那块宽度 ——
 * 展开时是 380 多，折叠时（面板被 `translateX` 推到屏幕外）自然算成 0，
 * 不需要为两种状态各写一条分支。
 *
 * ⚠️ 折叠**不做 CSS 过渡**：面板滑出去要 200ms，而绘图区的重新居中是一瞬间的，
 * 两者一起放会显得脱节。少一个动画，换来"按下就到位"的手感和可以立刻断言的 e2e。
 */
function syncPanelInset(): void {
  const collapsed = chatEl.dataset.collapsed === 'true';
  chatToggleEl.hidden = !collapsed;
  const panel = chatEl.getBoundingClientRect();
  const box = stageEl.getBoundingClientRect();
  const inset = Math.max(0, Math.round(box.right - panel.left));
  stage.setPanelInset(inset);
  // 表单图层浮在绘图区中央 —— 得按**没被压住**的那块居中，否则右半边钻到面板底下。
  // 走 CSS 变量而不是让表单身算：居中是布局的事，布局的事该由 CSS 说，
  // 而变量的值只有 JS 量得到（面板宽度随字体与滚动条变）。
  stageEl.style.setProperty('--stage-usable-w', `${box.width - inset}px`);
}

/**
 * 尺寸跟视口走用 `ResizeObserver` 盯 `#stage`，**不用 `window.resize`**：
 * 面板折叠不会触发 window resize，但会改变绘图区的可用宽度；
 * 而且开发者工具拖来拖去也不一定触发 window resize。观察元素自己是唯一准的。
 */
new ResizeObserver(() => stage.resize()).observe(stageEl);

collapseEl.addEventListener('click', () => {
  chatEl.dataset.collapsed = 'true';
  syncPanelInset();
});

chatToggleEl.addEventListener('click', () => {
  chatEl.dataset.collapsed = 'false';
  syncPanelInset();
});

// 首屏的兜底：面板宽度受字体与滚动条影响，`syncPanelInset()` 上面已经量过一次；
// 这里再走一遍 `resize()`，让图层按最终尺寸对齐一遍（`ResizeObserver` 也会触发，
// 但首帧之前那次观察不一定已经派发）。
stage.resize();

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
  '把工艺图放大',
  '让图元闪烁',
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

/**
 * 把归约后的状态与绘图区的事实挂出来。
 *
 * 这不是"为测试而加的钩子"——这是个控制台，SSE 流是看不见摸不着的，
 * 没有它就只能靠猜"现在到底收到了什么"。调试价值是主要的，e2e 能断言协议层
 * 的状态（而不是只能断言像素）是顺带的好处。
 *
 * ⚠️ 下面这些查询一律指向**绘图区当前显示的那一层**，不再是"最后一张卡片"。
 * 布局反转之后"最后一张卡片"这个概念已经不存在了。
 */
(globalThis as any).__iceAgentConsole = {
  getState: () => state,
  apiUrl: () => apiUrl(),
  /** 绘图区事实：当前是哪种图层、各层建过几次、几块画布。 */
  stageInfo: () => stage.info(),
  /** 控件条上各按钮的矩形。canvas 里没有 DOM 目标可定位，e2e 要点中某个按钮就得知道它画在哪。 */
  widgetRects: () => stage.widgetRects(),
  /** 表单提交按钮的页面坐标。canvas 里没有 DOM 目标，e2e 要靠它点中。 */
  formSubmitPoint: () => stage.formSubmitPoint(),
  /** 往表单里写值。canvas 表单没法用 DOM 填，测试与调试需要这个口。 */
  fillForm: (values: Record<string, any>) => stage.fillForm(values),
  /** 表单里各字段**画出来的文字**。用来断言占位文案真的落到了画布上。 */
  formFieldTexts: () => stage.formFieldTexts(),
  /** 表单里各字段的**值**。用来断言新类型真的进了取值回路。 */
  formValues: () => stage.formValues(),
  /**
   * 工艺图的模型层事实：符号数 / 管线数 / 工艺校验问题。
   *
   * 为什么 e2e 需要它：canvas 里没有 DOM 目标，而"图对不对"是**模型层**的事实
   * （34 个符号、37 段管线、`validateWater()` 零问题）。只数像素证明不了数量对。
   */
  diagramStats: () => stage.diagramStats(),
  /** 工艺图里被「指着讲」高亮的单元 id。 */
  diagramPointedId: () => stage.diagramPointedId(),
  /**
   * 工艺图的视口与"内容画到屏幕哪儿了"。
   * canvas 里没有 DOM 目标，"有没有被裁到框外"只能靠它算。
   */
  diagramViewport: () => stage.diagramViewport(),
  /** 工艺图的视口 + 上一次缩放命令（e2e 断言"缩放落在哪、在不在动"）。 */
  diagramZoom: () => stage.diagramZoom(),
  /** 工艺图的闪烁状态（opacity / 是否在动）。 */
  diagramBlink: () => stage.diagramBlink(),
  /**
   * 清掉「指着讲」的高亮。
   *
   * 这条走的是协议里已有的 `ice/point-clear`（`EVT_POINT_CLEAR`），
   * 但**没有任何剧本会发它**（讲完留着高亮是刻意的）—— 于是这条路径一直没被走过。
   * 把这个口子开出来，测试才能做"有高亮 / 没高亮"的对照，而不是只能断言"有"。
   */
  clearPoint: () => stage.clearPoint(),
  /**
   * 整图适配：把**全部**图元框进可视区（"看整张图纸"）。
   *
   * 和开页那一屏（按 DSL 的 `viewport.focus` 取景）是两个不同的取景：
   * 这个是远看、那个是近看。截图脚本与"图有没有被裁掉"的断言都要它。
   */
  fitAll: () => stage.fitAll(),
};

inputEl.focus();
updateMeta();
