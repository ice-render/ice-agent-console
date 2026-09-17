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
import { apiUrl } from '../domain/agui/client';
import { pickTransport, resolveRunMode, BUILD_DEFAULT_DEMO, type RunMode } from '../domain/agui/transport';
import { AUTOPLAY_OPENING, resolveAutoplay } from '../domain/agui/autoplay';
import type { ResumeEntry, RunTransport } from '../domain/agui/run-input';
import { installTheme } from '../domain/theme';
import {
  initialState,
  reduce,
  type Action,
  type Effect,
  type TextItem,
  type ThreadState,
} from '../domain/agui/reducer';
import { ChatView, shieldFromCanvas } from '../view/chat';
import { StageView, type StageMountResult } from '../view/stage';
import type { WidgetAction } from '../view/widget-layer';

// ---------------------------------------------------------------------------
// 跑一次 run
// ---------------------------------------------------------------------------

interface SendOptions {
  /** 图上交互产生的结构化上下文。 */
  interaction?: Record<string, any>;
  /** 这是自修复的自动重试，不要再插一条用户气泡。 */
  auto?: boolean;
  /**
   * 这一轮是**开页自动开演**，不是用户点的。
   *
   * 与 `auto` 分开两个字段而不是合成一个：`auto`（自修复重试）**不该被打断**
   * —— 它是回路自己的一步；而自动开演是"替用户按一下"，用户一动手就该让位。
   */
  autoplay?: boolean;
  /** 对上一轮中断的答复。协议规定恢复中断 = 开新 run + 带上它。 */
  resume?: ResumeEntry[];
}

/**
 * Agent Console 的**页面类**（一页一个类，见 AGENTS「页面写法」）。
 *
 * 装配、状态、事件接线都在这里；各层（绘图区 / 对话面板 / 纯逻辑）在 `src/view/` 与
 * `src/domain/`。构造期建好并挂出调试句柄 —— `window.__iceAgentConsole` 就是这个实例，
 * 方法承载"跑一轮 run / 布局 / 自动开演"这些动作。
 */
class AgentConsolePage {
  private readonly stageEl: HTMLElement;
  private readonly chatEl: HTMLElement;
  private readonly chatToggleEl: HTMLElement;
  private readonly threadEl: HTMLElement;
  private readonly metaEl: HTMLElement;
  private readonly formEl: HTMLFormElement;
  private readonly inputEl: HTMLTextAreaElement;
  private readonly sendEl: HTMLButtonElement;
  private readonly chipsEl: HTMLElement;
  private readonly collapseEl: HTMLElement;
  private readonly RUN_MODE: RunMode;
  private readonly transport: RunTransport;
  private readonly AUTOPLAY: boolean;
  private readonly threadId: string;
  private state: ThreadState;
  private running: boolean;
  private autoplayAbort: AbortController | null;
  private autoplayDone: Promise<void> | null;
  private pendingDiagnostics: string | null;
  private failedTool: string | null;
  private autoRepairUsed: boolean;
  private readonly stage: StageView;
  private readonly view: ChatView;

  constructor() {

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
    this.stageEl = stageEl; this.chatEl = chatEl; this.chatToggleEl = chatToggleEl; this.threadEl = threadEl; this.metaEl = metaEl; this.formEl = formEl; this.inputEl = inputEl; this.sendEl = sendEl; this.chipsEl = chipsEl; this.collapseEl = collapseEl;

    // ---------------------------------------------------------------------------
    // 状态
    // ---------------------------------------------------------------------------

    // **主题必须在任何组件构造之前装** —— 库的主题是"组件构造时读一次"。
    // 放这儿而不是放进 `main.ts`：这里就是"第一个会造组件的地方"的上游。
    installTheme();

    /**
     * **这次跑哪种 transport**：连后端，还是在浏览器里跑剧本。
     *
     * 判定放在模块顶层（只算一次）：模式是**构建期 / 开页时**决定的事，
     * 不该在每一轮 run 里重新解释一遍 URL。优先级见 `transport.ts`。
     */
    this.RUN_MODE = resolveRunMode(globalThis.location?.search ?? '');
    this.transport = pickTransport(this.RUN_MODE);

    /**
     * **开页要不要自己先演一遍**（不等任何人点）。
     *
     * 两级优先见 `autoplay.ts`。这里那处 `RUN_MODE === 'demo'` 是**只加在构建期默认上**的
     * 一道限制：演示构建默认自动开演，但如果有人用 `?demo=0` 把它切回"连后端"，
     * 后端多半没起 —— 那样开页就会自己弹一张红色错误卡。第一印象不该是一张错误卡。
     *
     * ⚠️ 这道限制**不能盖过显式参数**：`?autoplay=1` 是用户点名要看，
     * 那就演（失败了也有那张错误卡解释，那正是它存在的意义）。
     */
    this.AUTOPLAY = resolveAutoplay(
      globalThis.location?.search ?? '',
      BUILD_DEFAULT_DEMO && this.RUN_MODE === 'demo'
    );

    this.threadId = `thread_${Math.random().toString(36).slice(2, 10)}`;
    this.state = initialState(this.threadId);
    this.running = false;

    /**
     * 自动开演那一轮的取消句柄。用户一动手就掐掉它 —— 见 `send()` 的开头。
     *
     * 为什么需要：`send()` 有 `if (running) return` 的护栏，而自动开演要跑 19 秒。
     * 没有取消的话，那 19 秒里用户点按钮 / 打字全部被**静默吞掉**，
     * 页面看着能点其实没反应 —— 比不自动开演还糟。
     */
    this.autoplayAbort = null;
    /** 自动开演那一轮的 Promise，用来"等它真的停下来"再放用户那一下过去。 */
    this.autoplayDone = null;

    /** 渲染端诊断。跨轮存活，所以要放在归约器外面。 */
    this.pendingDiagnostics = null;

    /**
     * 这一轮失败的是哪个工具（`render_chart` / `collect_input` / `render_diagram`）。
     *
     * 与 `pendingDiagnostics` 同生命周期：诊断说"哪里错了"，这个说"什么东西错了"。
     * 修复轮据此吐回同一种图层。
     */
    this.failedTool = null;
    /** 自修复只自动重试一次，避免"诊断永远修不好"时无限打转。 */
    this.autoRepairUsed = false;

    this.stage = new StageView(this.stageEl, {
      handlers: {
        onItemClick: (p) => {
          // 上行第 1 种：用户点了一个数据点。这正是"点击触发"的入口——
          // 没有对话面也可以跑 run，AG-UI 只规范 run 内部，不管 run 由谁触发。
          void this.send(`我点了「${p.xValue}」这个点，这里为什么是这样？`, {
            interaction: { kind: 'item-click', ...p },
          });
        },
        onBrushEnd: (range) => {
          // 上行第 2 种：用户框选了一段区间。
          // 结构化数据走 context，而不是塞进用户说的话里——两者语义不同，不该糊在一起。
          const span = range?.x ? `${range.x[0]} ~ ${range.x[1]}` : '一段区间';
          void this.send(`我框选了 ${span}，这里为什么波动？`, {
            interaction: { kind: 'brush', range },
          });
        },
      },
      widgets: {
        // 图表图层底部的控件条（第二块画布，浮在绘图区底部）
        actions: AgentConsolePage.WIDGET_ACTIONS,
        // 上行第 3 种：**canvas 控件**上的点击。
        // 前两种来自图表那张画布，这一种来自控件条那张 —— 两个 ICE 实例、两张画布，
        // 走的是同一条协议通道。
        onAction: (actionId) => {
          void this.send(AgentConsolePage.WIDGET_PROMPTS[actionId] ?? actionId, {
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
        const pending = this.state.interrupt;
        this.dispatch({ type: '@local/form-submitted', toolCallId });
        this.stage.markFormSubmitted();

        const summary = Object.entries(values)
          .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('/') : value}`)
          .join(', ');
        void this.send(`（已提交表单：${summary}）`, {
          ...(pending
            ? {
                resume: [{ interruptId: pending.id, status: 'resolved' as const, payload: values }],
              }
            : {}),
        });
      },
    });

    this.view = new ChatView(this.threadEl);

    /**
     * 面板对画布"透明化"：拦在我们**整个面板**（`#chat`）上，而不是消息区。
     *
     * 面板里现在有四块 DOM：顶栏、消息区、快捷按钮 + 输入框、底部那排家族链接。
     * 拦在面板根上，这四块一次覆盖 —— 往面板里再加东西也不用回来改。
     * 为什么这件事必须做、以及"为什么它今天看不出效果"（实测），见 `chat.ts` 顶部的注释。
     */
    shieldFromCanvas(this.chatEl);

    /**
     * 先让绘图区知道面板占了右边多少，**再**画图。
     *
     * 顺序是承重的：`DiagramLayer` 的初始视野**只设一次**，那一次就要按真实可视区算。
     * 反过来的话第一版视野会按整幅画布居中（图的中间落在面板底下），
     * 然后要靠一次 `reframe()` 纠正 —— 画面会闪一下，而且多算一遍。
     */
    this.syncPanelInset();

    /**
     * 开页就把工艺图画上。
     *
     * 这是布局反转的第一条需求（"一开始就显示工艺图"）的落点。放在 `installTheme()` 之后、
     * 任何 run 之前：绘图区是主体，它不该等用户说第一句话。
     *
     * 数据从 `shared/water-process-case.ts` 来 —— 放 `shared/` 的唯一原因就是这里：
     * 服务端写计划、前端画图，一份来源。
     */
    if (this.stage.mount('render_diagram', WATER_PROCESS_DSL).ok) {
      this.updateMeta();
    }

    /**
     * 尺寸跟视口走用 `ResizeObserver` 盯 `#stage`，**不用 `window.resize`**：
     * 面板折叠不会触发 window resize，但会改变绘图区的可用宽度；
     * 而且开发者工具拖来拖去也不一定触发 window resize。观察元素自己是唯一准的。
     */
    new ResizeObserver(() => this.stage.resize()).observe(this.stageEl);

    this.collapseEl.addEventListener('click', () => {
      this.chatEl.dataset.collapsed = 'true';
      this.syncPanelInset();
    });

    this.chatToggleEl.addEventListener('click', () => {
      this.chatEl.dataset.collapsed = 'false';
      this.syncPanelInset();
    });

    // 首屏的兜底：面板宽度受字体与滚动条影响，`syncPanelInset()` 上面已经量过一次；
    // 这里再走一遍 `resize()`，让图层按最终尺寸对齐一遍（`ResizeObserver` 也会触发，
    // 但首帧之前那次观察不一定已经派发）。
    this.stage.resize();

    for (const group of AgentConsolePage.CHIP_GROUPS) {
      // 组名占满一行（`flex-basis: 100%`）—— 靠 flex 换行实现，不用另起容器
      const label = document.createElement('span');
      label.className = 'chip-group';
      label.textContent = group.label;
      this.chipsEl.append(label);

      for (const text of group.chips) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.textContent = text;
        chip.addEventListener('click', () => void this.send(text));
        this.chipsEl.append(chip);
      }
    }

    this.formEl.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = this.inputEl.value.trim();
      if (!text) return;
      this.inputEl.value = '';
      this.inputEl.style.height = '';
      void this.send(text);
    });

    this.inputEl.addEventListener('keydown', (event) => {
      // Enter 发送，Shift+Enter 换行
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.formEl.requestSubmit();
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
      getState: () => this.state,
      apiUrl: () => apiUrl(),
      /**
       * 这次跑的是哪一路 transport（`'server'` / `'demo'`）。
       *
       * e2e 用它断言"开关真的生效了"—— 比只看画面强：演示模式下画面本来就该与
       * 连后端时一模一样，看不出区别。
       */
      runMode: () => this.RUN_MODE,
      /** 绘图区事实：当前是哪种图层、各层建过几次、几块画布。 */
      stageInfo: () => this.stage.info(),
      /** 控件条上各按钮的矩形。canvas 里没有 DOM 目标可定位，e2e 要点中某个按钮就得知道它画在哪。 */
      widgetRects: () => this.stage.widgetRects(),
      /** 表单提交按钮的页面坐标。canvas 里没有 DOM 目标，e2e 要靠它点中。 */
      formSubmitPoint: () => this.stage.formSubmitPoint(),
      /** 往表单里写值。canvas 表单没法用 DOM 填，测试与调试需要这个口。 */
      fillForm: (values: Record<string, any>) => this.stage.fillForm(values),
      /** 表单里各字段**画出来的文字**。用来断言占位文案真的落到了画布上。 */
      formFieldTexts: () => this.stage.formFieldTexts(),
      /** 表单里各字段的**值**。用来断言新类型真的进了取值回路。 */
      formValues: () => this.stage.formValues(),
      /**
       * 工艺图的模型层事实：符号数 / 管线数 / 工艺校验问题。
       *
       * 为什么 e2e 需要它：canvas 里没有 DOM 目标，而"图对不对"是**模型层**的事实
       * （68 个符号、81 段管线、`validateWater()` 零问题）。只数像素证明不了数量对。
       */
      diagramStats: () => this.stage.diagramStats(),
      /** 工艺图里被「指着讲」高亮的单元 id。 */
      diagramPointedId: () => this.stage.diagramPointedId(),
      /**
       * 工艺图的视口与"内容画到屏幕哪儿了"。
       * canvas 里没有 DOM 目标，"有没有被裁到框外"只能靠它算。
       */
      diagramViewport: () => this.stage.diagramViewport(),
      /** 工艺图的视口 + 上一次缩放命令（e2e 断言"缩放落在哪、在不在动"）。 */
      diagramZoom: () => this.stage.diagramZoom(),
      /** 工艺图的闪烁状态（opacity / 是否在动）。 */
      diagramBlink: () => this.stage.diagramBlink(),
      /**
       * 清掉「指着讲」的高亮。
       *
       * 这条走的是协议里已有的 `ice/point-clear`（`EVT_POINT_CLEAR`），
       * 但**没有任何剧本会发它**（讲完留着高亮是刻意的）—— 于是这条路径一直没被走过。
       * 把这个口子开出来，测试才能做"有高亮 / 没高亮"的对照，而不是只能断言"有"。
       */
      clearPoint: () => this.stage.clearPoint(),
      /**
       * 整图适配：把**全部**图元框进可视区（"看整张图纸"）。
       *
       * 和开页那一屏（按 DSL 的 `viewport.focus` 取景）是两个不同的取景：
       * 这个是远看、那个是近看。截图脚本与"图有没有被裁掉"的断言都要它。
       */
      fitAll: () => this.stage.fitAll(),
      /**
       * 每个单元的**真实渲染包围盒**（世界坐标，含标签）。
       *
       * 用来量"图元之间有没有叠" —— 那是唯一一个既不会报错、`validateWater()` 也查不出
       * （它只管工艺语义）、只有人眼看得见的问题。见 `StageView.diagramBoxes()`。
       */
      diagramBoxes: () => this.stage.diagramBoxes(),
      /**
       * 每条管线的**标注盒**（`DN700 污水` 那类文字，画在折线中点上）。
       *
       * 与 `diagramBoxes()` 分开：画面上"叠"有三种来路 —— 单元压单元、标注压标注、
       * 单元压标注。前两种必须一起量，否则会像第一轮那样只解决了一半。
       */
      diagramEdgeLabels: () => this.stage.diagramEdgeLabels(),
      /** 这次开页会不会自动演一遍（e2e 断言"开关真的在起作用"，比只看画面强）。 */
      autoplayEnabled: () => this.AUTOPLAY,
    };

    this.inputEl.focus();
    this.updateMeta();

    // 开页自动开演 —— 放在最后：上面那些接线（stage / chat / 按钮）都得到位，
    // 否则第一拍的命令没有落点。它自己会等绘图区量到尺寸，所以不用再包一层 rAF。
    if (this.AUTOPLAY) void this.startAutoplay();
  }


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
  private static readonly WIDGET_ACTIONS: WidgetAction[] = [
    { id: 'explain', text: '解释这张图', variant: 'primary' },
    { id: 'redraw', text: '换个画法' },
    { id: 'stream', text: '看实时数据' },
  ];


  /** 控件动作 → 送给 agent 的一句话。 */
  private static readonly WIDGET_PROMPTS: Record<string, string> = {
    explain: '解释一下这张图',
    redraw: '换个画法',
    stream: '看一下实时吞吐量',
  };


  /**
   * 开页自动开演：等绘图区真的能接受镜头命令了，再替用户按下第一个快捷按钮。
   *
   * ## 为什么要等"能接受镜头命令"
   *
   * 讲稿的第一拍是 `{ direction: 'fit' }`（把整张图框进来），而 `DiagramLayer.zoomBy()`
   * 在 `cssWidth / cssHeight` 还没量到时会**返回 false 把命令丢掉**。
   * 图层建好 ≠ 尺寸量到：尺寸是 `ResizeObserver` 派发的，在首帧之后。
   * 不等的话第一拍会被静默丢掉 —— 而画面只是"从初始视野直接跳到第二拍"，看不出少了什么。
   *
   * ## 为什么要等一小会儿才开演
   *
   * 开页那一屏（按 `viewport.focus` 取的近景）得先**被人看见**，
   * 然后那次 `fit` 的缩放补间才读得出是"镜头拉开、开始讲了"。
   * 紧接着开演的话，两个画面之间没有停顿，看着像布局抖了一下。
   */
  private static readonly AUTOPLAY_DELAY_MS: number = 700;


  // ---------------------------------------------------------------------------
  // 输入
  // ---------------------------------------------------------------------------

  /**
   * 快捷按钮：**按"作用在哪"分两组，工艺图那组在最前**。
   *
   * 为什么值得分组而不是平铺一张列表：这里 11 个按钮里**有 5 个是工艺图专用的**
   * （那张图是整页主体，会话里的大多数动作都作用在它上面），另外 6 个才是
   * "切到别的界面 / 走别的回路"。平铺的时候两组是混着的，而混着有个具体的坏处：
   * `故意画错` 与 `故意画错工艺图` 只差三个字、作用对象完全不同，隔开摆很容易点错。
   *
   * 组内顺序按**从"看"到"改"**排，正好也是心智上的递进：
   * 先看它 → 调镜头 → 标重点 → 改结构 → 出错了修回来。
   */
  private static readonly CHIP_GROUPS: Array<{ label: string; chips: string[] }> = [
    {
      label: '工艺图',
      chips: [
        '看看污水处理工艺图',
        '把工艺图放大',
        '让图元闪烁',
        '提标改造',
        '故意画错工艺图',
      ],
    },
    {
      label: '其他',
      chips: [
        '看看各渠道的月度销量',
        '看一下实时吞吐量',
        '要下发指令',
        '看看新控件都能用吗',
        '故意画错',
        '今天天气怎么样',
      ],
    },
  ];


  dispatch(action: Action): void {
    const { state: next, effects } = reduce(this.state, action);
    this.state = next;

    // 先渲染再执行 effects：mount 要用渲染阶段创建出来的条目（hint 要写进去）
    this.view.render(this.state);

    const feedback = this.applyEffects(effects);
    if (feedback !== null) {
      // 两件事都要做，少一件回路就是断的：
      //   1. 写进归约状态（界面要能显示"校验没通过"）
      //   2. 记到 pendingDiagnostics（下一轮 run 要把它塞进 context 送给 agent）
      // 第一版只做了 1，结果自修复那一轮从来没被触发过——e2e 才把它逼出来。
      this.pendingDiagnostics = feedback;
      this.state = reduce(this.state, { type: '@local/diagnostics', text: feedback }).state;
    }

    this.updateMeta();
  }


  /** 执行 effects。返回本轮新产生的诊断文本（如果有）。 */
  applyEffects(effects: Effect[]): string | null {
    let diagnostics: string | null = null;

    for (const effect of effects) {
      switch (effect.type) {
        case 'mount-chart': {
          const entry = this.view.entry(effect.toolCallId);
          const tool = entry?.tool ?? '';
          const result = this.stage.mount(tool, effect.dsl, effect.toolCallId);
          if (result.ok) {
            entry?.markMounted(this.hintFor(tool, effect.dsl, result));
            this.view.markActive(effect.toolCallId);
          } else {
            entry?.markFailed('校验不通过', result.diagnostics);
            // 记下是哪种图层失败了：修复轮要吐回同一种形态（见 shared/contract.ts 的
            // DSL_TOOL_CONTEXT_KEY）。不记的话「图 DSL 写错了」会被修成一张柱状图。
            this.failedTool = tool || null;
            diagnostics = result.diagnostics;
          }
          break;
        }
        case 'append-rows': {
          if (!this.stage.appendRows(effect.rows)) {
            // 快路径判不了（比如类目轴要补 xAxis.data）→ 退回全量重绘。
            // 慢一点但一定对，这比"看起来更快但偶尔画错"强。
            if (this.state.sharedState?.chart) {
              const result = this.stage.mount('render_chart', this.state.sharedState.chart);
              if (!result.ok) diagnostics = result.diagnostics;
            }
          }
          break;
        }
        case 'point-at': {
          // 「指着讲」：作用在绘图区**当前显示的那一层**上（工艺图走高亮，图表走悬停）
          this.stage.pointAt(effect.value, { blink: effect.blink === true });
          break;
        }
        case 'clear-point': {
          this.stage.clearPoint();
          break;
        }
        case 'patch-diagram': {
          // 增量增删图元：走 `createSymbol` / `designer.remove`，**不重建图层**。
          // 落不到（绘图区上不是工艺图）就退一次全量 —— 便宜的路走不通时，
          // 走对的那条。`state.sharedState.diagram` 是补丁**之后**那份，就是最新真相。
          // 把补丁**之后**那份 DSL 一起递进去：图层要用它更新"该框住哪一段"
          // （`viewport.focus` 会被补丁改，而图层不解析补丁、只采纳结果）。
          const patchedDsl = this.state.sharedState?.diagram;
          const result = this.stage.patchDiagram(effect, patchedDsl);
          if (result === null) {
            if (patchedDsl) {
              const fallback = this.stage.mount('render_diagram', patchedDsl);
              if (!fallback.ok) diagnostics = fallback.diagnostics;
            }
          }
          break;
        }
        case 'zoom': {
          // 缩放视图：只有工艺图会响应（图表返回 false，静默）。这是"查看"动作，不是编辑。
          //
          // ⚠️ 每个可选字段都要**逐个转交**（`undefined` 不能进去）——
          // 有一次加 `scale` 时漏了这一行，结果是 `to` 命令到了视图层却没有目标倍率、
          // 被当作非法整条丢掉，症状是"讲稿里推镜头的那几拍画面纹丝不动"（而且不报错）。
          this.stage.zoomView({
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
  hintFor(tool: string, dsl: unknown, result: StageMountResult): string {
    const bytes = JSON.stringify(dsl)?.length ?? 0;
    const kind = result.kind;

    if (kind === 'diagram') {
      const stats = this.stage.diagramStats();
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


  updateMeta(): void {
    const info = this.stage.info();
    const tools = this.state.items.filter((i) => i.kind === 'tool' && i.status !== 'streaming').length;
    const status =
      this.state.status === 'running'
        ? '运行中'
        : this.state.status === 'waiting'
          ? '等待作答'
          : this.state.status === 'error'
            ? '出错'
            : '空闲';
    this.metaEl!.innerHTML =
      // 演示模式**必须显式标出来**：它走的是内置剧本、没有任何真模型参与，
      // 不标的话第一次看到的人会以为"模型模式坏了"（或者以为背后真有个 agent）。
      (this.RUN_MODE === 'demo' ? `演示模式<b>纯前端</b> · ` : '') +
      `thread <b>${this.state.threadId.slice(-6)}</b> · ` +
      `事件 <b>${this.state.eventCount}</b> · ` +
      `绘图区 <b>${info.active ?? '空'}</b> · ` +
      `工具 <b>${tools}</b> · ` +
      `<b>${status}</b>` +
      (this.state.error ? ` · ${this.state.error}` : '');
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
  syncPanelInset(): void {
    const collapsed = this.chatEl.dataset.collapsed === 'true';
    this.chatToggleEl.hidden = !collapsed;
    const panel = this.chatEl.getBoundingClientRect();
    const box = this.stageEl.getBoundingClientRect();
    const inset = Math.max(0, Math.round(box.right - panel.left));
    this.stage.setPanelInset(inset);
    // 表单图层浮在绘图区中央 —— 得按**没被压住**的那块居中，否则右半边钻到面板底下。
    // 走 CSS 变量而不是让表单身算：居中是布局的事，布局的事该由 CSS 说，
    // 而变量的值只有 JS 量得到（面板宽度随字体与滚动条变）。
    this.stageEl.style.setProperty('--stage-usable-w', `${box.width - inset}px`);
  }


  /**
   * 掐掉正在跑的自动开演，并**等它真的停下来**。
   *
   * 后面那个"等"是必须的：`send()` 用 `running` 做护栏，而取消是异步的 ——
   * 不 await 的话紧接着的用户那一轮会被护栏静默吞掉，等于没让位。
   */
  async cancelAutoplay(): Promise<void> {
    if (!this.autoplayAbort) return;
    const controller = this.autoplayAbort;
    this.autoplayAbort = null;
    controller.abort();
    try {
      await this.autoplayDone;
    } catch {
      /* 取消路径不该往外抛：错误已经由 onError 转成状态了 */
    }
    this.autoplayDone = null;
  }


  async send(text: string, options: SendOptions = {}): Promise<void> {
    // **用户优先于自动开演**：这是"自动播放"能不能讨人喜欢的关键。
    // 不加这一段的话，开页那 19 秒里点按钮 / 打字全被 `running` 护栏吞掉，
    // 页面看着能点其实没反应。
    if (!options.auto && !options.autoplay) await this.cancelAutoplay();

    if (this.running) return;

    if (!options.auto) {
      this.dispatch({ type: '@local/user-message', text });
      this.autoRepairUsed = false;
    }

    // 自动开演这一轮带 signal，好让用户能掐掉它；其余轮次不带（没有取消入口）
    const controller = options.autoplay ? new AbortController() : null;

    this.running = true;
    this.sendEl!.disabled = true;
    this.updateMeta();

    // context 是 AG-UI 留给应用扩展的通道。这里装两样东西：
    // 上一轮渲染端的诊断（自修复用）、用户在图上做的事（追问用）。
    const context: Array<{ description: string; value: string }> = [];
    if (this.pendingDiagnostics) {
      context.push({ description: DSL_DIAGNOSTICS_CONTEXT_KEY, value: this.pendingDiagnostics });
      if (this.failedTool) {
        context.push({ description: DSL_TOOL_CONTEXT_KEY, value: this.failedTool });
      }
      this.pendingDiagnostics = null;
      this.failedTool = null;
    }
    if (options.interaction) {
      context.push({
        description: VIEW_INTERACTION_CONTEXT_KEY,
        value: JSON.stringify(options.interaction),
      });
    }

    const messages = this.state.items
      .filter((item): item is TextItem => item.kind === 'text')
      .map((item) => ({ id: item.id, role: item.role, content: item.text }));

    const runId = `run_${Date.now().toString(36)}`;

    try {
      await this.transport(
        {
          threadId: this.threadId,
          runId,
          messages,
          state: this.state.sharedState ?? {},
          context,
          ...(options.resume ? { resume: options.resume } : {}),
        },
        {
          onEvent: (event) => this.dispatch(event),
          onError: (err) => this.dispatch({ type: 'RUN_ERROR', message: err.message }),
        },
        // 只有自动开演那一轮带 signal（见上面 controller 的注释）
        controller?.signal
      );
    } finally {
      this.running = false;
      this.sendEl!.disabled = false;
      if (controller && this.autoplayAbort === controller) this.autoplayAbort = null;
    }

    // 被用户掐掉的那一轮就**到此为止**，不需要额外收拾状态：
    // `transport` 对取消是静默返回（`AbortError` 不当错误上报），所以不会再有
    // `RUN_FINISHED`；而状态不用管 —— 会走到这里的取消只有一条来路（用户抢在自动开演
    // 前面动了手），那一下**必定**接着开一轮新的 run，`RUN_STARTED` 会把状态推回 running。
    // 实测过：这里去掉一个"把 status 推回 idle"的动作，用例照样过（说明它是多余的）。
    //
    // ⚠️ 以后若加了**不跟着开 run** 的取消入口（比如 Esc 停止），
    //    这里就得补一个把 `status` 推回 `idle` 的动作 —— 否则界面会一直停在"运行中"。
    if (controller?.signal.aborted) return;

    // 自修复回路：这一轮渲染端报了错，就带着诊断自动再来一次。
    // 脚本化阶段就把这条回路走通，M2 换成真模型时这一段的代码一行都不用动。
    if (this.pendingDiagnostics && !this.autoRepairUsed) {
      this.autoRepairUsed = true;
      await this.send('', { auto: true });
      return;
    }

    this.updateMeta();
  }


  /** 绘图区量到尺寸了吗（`zoomBy` 能生效的前提）。 */
  diagramReady(): boolean {
    const vp = this.stage.diagramViewport();
    return !!vp && vp.cssWidth > 0 && vp.cssHeight > 0;
  }


  async startAutoplay(): Promise<void> {
    // 等尺寸：最多 ~2 秒（120 帧），超时就放弃自动开演而不是硬跑
    for (let i = 0; i < 120 && !this.diagramReady(); i++) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    }
    if (!this.diagramReady()) return;

    await new Promise((resolve) => setTimeout(resolve, AgentConsolePage.AUTOPLAY_DELAY_MS));

    // 用户在这些等待里已经动过手（点了按钮 / 打字 / 上一轮已经跑起来了）就别抢戏。
    // 归约器每收到一条用户消息就会往 items 里追加，所以 items 非空 = 已经有人在用了。
    if (this.running || this.state.items.length > 0) return;

    const controller = new AbortController();
    this.autoplayAbort = controller;
    this.autoplayDone = this.send(AUTOPLAY_OPENING, { autoplay: true });
    await this.autoplayDone;
  }

}

new AgentConsolePage();
