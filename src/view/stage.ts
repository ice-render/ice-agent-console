/**
 * **绘图区**：整页唯一的那块画布区域。
 *
 * ## 它解决的问题
 *
 * 之前的布局是"对话是主体，图表内联成卡片"。那个结构有两个硬伤：
 *
 * 1. **图在消息流里，所以每次都要重画一遍。** 每张卡片是一块新 canvas + 一个新 ICE
 *    实例，78 个符号 + 100 段管线要重建一次 —— 而用户只是在跟 agent 继续聊。
 * 2. **图和话是两条平行的流。** "把刚才那张图放大"没有"刚才那张图"可指，
 *    只能又画一张。
 *
 * 现在反过来：**绘图区是主体，对话浮在它上面**。图开页就画好、之后永不重建；
 * 对话里所有动作（指着讲、缩放、闪烁、切图表）都作用在**同一块绘图区**上。
 *
 * ## 为什么不是"一整块 canvas"（做不到，也不该做）
 *
 * 三条硬约束，都是引擎与家族包的模型决定的：
 *
 * 1. 引擎的模型是「**一层 = 一块 canvas + 一个 ICE 实例**」。两个实例共画一块画布会
 *    互相打脏矩形，事件总线也会打架。
 * 2. `ice-chart` 的 `createChart()` **内部自己 `new ICE()`**，不接受外部实例。
 * 3. `WaterProcessDesigner` 要独占一个实例（构造时会注册符号类型、装对齐引导线、挂 mousedown）。
 *
 * 所以绘图区是一个**铺满视口的容器**，容器里同一时刻只挂一个图层；每个图层自带
 * canvas + ICE 实例。这正是 `src/domain/ice/layer.ts` 那个原语存在的理由。
 *
 * ## 图层生命周期（这条直接回答"不用每次都重画"）
 *
 * | 图层 | 何时建 | 何时销毁 |
 * |---|---|---|
 * | diagram | **boot 时**（开页就在） | **永不** —— 它是这个应用的主视图 |
 * | chart | 第一次需要显示图表时 | 被 diagram / form 顶掉时 |
 * | form  | 第一次需要显示表单时 | 被 diagram / chart 顶掉时 |
 *
 * 于是"页面停在工艺图上"这个状态下**永远只有一块 canvas 活着**（diagram），
 * 比"每张卡片各留一块画布"低一个数量级。
 *
 * ## 三种图层各自的复用判据（**不一样，别统一**）
 *
 * - **diagram 按内容比对**：DSL 序列化后相同就只 `show`，一层都不重建。
 *   这是需求 #3 的落点 —— 反复 `render_diagram` 同一份数据不该有任何重绘。
 * - **chart 复用宿主**：`ChartAdapter.mount()` 本来就是"实例只建一次、
 *   后续 `setOption`"，所以图表之间换数据是**改**而不是**重建**。
 * - **form 每次重建**：表单是绑在一次中断上的（一次 `collect_input` 一张表），
 *   没有"增量更新一张表单"这回事。
 *
 * ## 失败时**不切画面**
 *
 * 校验没过就**不提交**：绘图区保持原样（很可能还停在上一张好图上），
 * 诊断只出现在对话里的那条工具条目上。旧行为是"卡片亮着、画布空白"，
 * 那会让人以为图坏了 —— 实际上坏的是 DSL，而且 agent 马上就会修。
 */
import { COLLECT_INPUT_TOOL, RENDER_DIAGRAM_TOOL, type ZoomDirection } from '../../shared/contract';
import type { InteractionHandlers } from './chart-adapter';
import { ChartAdapter } from './chart-adapter';
import { DiagramLayer, type DiagramRegion } from './diagram-layer';
import { FormLayer } from './form-layer';
import { WidgetLayer, type WidgetAction } from './widget-layer';
import { formatDiagramDiagnostics, validateDiagramDsl, type DiagramDiagnostic } from '../domain/diagram/validate';

export type StageLayerKind = 'diagram' | 'chart' | 'form';

export interface StageMountResult {
  ok: boolean;
  /** 校验 / 构建失败时的结构化诊断（同时用来回灌给 agent 做自修复）。 */
  diagnostics: string | null;
  /** 这次挂载落到哪个图层。失败时是 `null` —— 绘图区没动。 */
  kind: StageLayerKind | null;
  /** 这一层是**新建**的还是复用了已有的。e2e 靠它钉"没有重画"。 */
  built: boolean;
}

export interface StageWidgets {
  actions: WidgetAction[];
  onAction: (actionId: string, toolCallId: string) => void;
}

export interface StageOptions {
  /** 图表的图上交互（点数据点、框选）。 */
  handlers?: InteractionHandlers;
  /** 图表图层底部的控件条（第二块画布）。 */
  widgets?: StageWidgets;
  /** 表单层提交（且校验通过）时回调。 */
  onFormSubmit?: (values: Record<string, any>, toolCallId: string) => void;
}

/** 控件条高度（CSS 像素）。与 `.stage-widget` 的 CSS 写的是同一个数，改一处要改两处。 */
const WIDGET_BAR_HEIGHT = 56;

/** 一层在 DOM 里的宿主。三个实现（diagram / chart / form）都关在这一个文件里。 */
interface LayerHost {
  readonly kind: StageLayerKind;
  /** 该层的根元素（`.stage-layer`），显隐就是切它的 `hidden`。 */
  readonly el: HTMLElement;
  fit(width: number, height: number): void;
  destroy(): void;
}

/**
 * 这次 tool call 该出哪种图层。
 *
 * 与旧 `CardView.mount()` 的分派**同一套规矩**，只是"卡片形态"变成了"图层形态"。
 * 加一种图层仍然是"加一个工具名" —— 归约器与协议层一行都不用动。
 */
export function stageKindOf(tool: string): StageLayerKind {
  if (tool === RENDER_DIAGRAM_TOOL) return 'diagram';
  if (tool === COLLECT_INPUT_TOOL) return 'form';
  return 'chart';
}

export class StageView {
  private readonly layers = new Map<StageLayerKind, LayerHost>();
  private active: StageLayerKind | null = null;

  private cssWidth = 0;
  private cssHeight = 0;
  /**
   * 浮在绘图区右边的那块被面板压住的宽度（CSS 像素）。0 = 面板折叠。
   *
   * 画布是铺满的（连面板底下也画），但**内容居中与适配按没被压住的那块算** ——
   * 否则图的中间会落在面板底下、右边三分之一白白浪费。见 `DiagramRegion`。
   */
  private panelInset = 0;

  /** diagram 层的构造入参 —— 内容比对命中时要靠它证明"同一份数据"。 */
  private diagramKey: string | null = null;

  /** 当前 chart 层是给哪次 tool call 用的（控件条上行时要带上它）。 */
  private chartToolCallId = '';

  /** 各层建过几次。新建一次 +1，复用不加 —— e2e 用它断言"切回来没重画"。 */
  private readonly builds: Record<StageLayerKind, number> = { diagram: 0, chart: 0, form: 0 };
  /** 各层被显示过几次（含复用）。 */
  private readonly shows: Record<StageLayerKind, number> = { diagram: 0, chart: 0, form: 0 };

  constructor(
    private readonly root: HTMLElement,
    private readonly options: StageOptions = {}
  ) {}

  // -------------------------------------------------------------------------
  // 挂载
  // -------------------------------------------------------------------------

  /**
   * 把一次 tool call 的产物挂到绘图区上。**失败时不切画面**，只回诊断。
   *
   * @param tool       工具名 —— 决定出哪种图层（`stageKindOf`）
   * @param dsl        工具的参数（一份 DSL 文档）
   * @param toolCallId 这次调用在协议里的 id（控件条 / 表单上行时要带上）
   */
  mount(tool: string, dsl: unknown, toolCallId = ''): StageMountResult {
    // 先量尺寸再动手 —— 见 `__measure()`。调用顺序不该是承重的。
    this.__measure();
    const kind = stageKindOf(tool);
    if (kind === 'diagram') return this.mountDiagram(dsl);
    if (kind === 'form') return this.mountForm(dsl, toolCallId);
    return this.mountChart(dsl, toolCallId);
  }

  /**
   * 工艺图：**按内容比对**。
   *
   * 同一份 DSL 再挂一次 = 只是把这一层显示出来，一个符号都不重建。
   * 这正是"不用每次都重新绘制完整的工艺图"那句需求的落点。
   */
  mountDiagram(dsl: unknown): StageMountResult {
    const result = validateDiagramDsl(dsl);
    if (!result.valid) {
      // 校验没过就**不提交**：绘图区保持原样（很可能还停在上一张好图上）
      return { ok: false, diagnostics: formatDiagramDiagnostics(result), kind: null, built: false };
    }

    const key = safeKey(dsl);
    if (this.layers.has('diagram') && key !== null && key === this.diagramKey) {
      // 内容一模一样：只把它显示出来（顺带把图表 / 表单层收掉）
      this.show('diagram');
      return { ok: true, diagnostics: diagramWarnings(result.warnings), kind: 'diagram', built: false };
    }

    let host: DiagramHost;
    try {
      host = new DiagramHost(dsl as any, this.cssWidth, this.cssHeight, this.__region());
    } catch (err) {
      // 校验过了但视图层仍然抛（引擎 / 设计器 / 画布尺寸）：同样走诊断回灌。
      // 旧层不动 —— 半建成的层已经由 DiagramHost 自己收干净了。
      return {
        ok: false,
        diagnostics: `[错误] 建图失败：${(err as Error).message}`,
        kind: null,
        built: false,
      };
    }

    this.__replace('diagram', host);
    this.diagramKey = key;
    this.builds.diagram++;
    this.show('diagram');
    return { ok: true, diagnostics: diagramWarnings(result.warnings), kind: 'diagram', built: true };
  }

  /**
   * 图表：**复用宿主**。
   *
   * 宿主在就一直用同一个 `ChartAdapter`（它内部 `setOption` 换数据而不是重建图表实例），
   * 这也是旧实现里"不要用 `renderChartDsl`"那条结论的自然延伸 —— 现在连"每张卡片一个
   * 实例"都省掉了。
   */
  mountChart(dsl: unknown, toolCallId = ''): StageMountResult {
    const existing = this.layers.get('chart') as ChartHost | undefined;
    const host = existing ?? new ChartHost(this.options, this.cssWidth, this.cssHeight, () => this.chartToolCallId);

    const result = host.mount(dsl);
    if (!result.ok) {
      // 失败不提交。新建的宿主直接扔掉 —— 留着就是一块白画布 + 一个空实例
      if (!existing) host.destroy();
      return { ok: false, diagnostics: result.diagnostics, kind: null, built: false };
    }

    if (toolCallId) this.chartToolCallId = toolCallId;
    if (!existing) {
      this.builds.chart++;
      this.__replace('chart', host);
    }
    this.show('chart');
    return { ok: true, diagnostics: result.diagnostics, kind: 'chart', built: !existing };
  }

  /**
   * 表单：**每次重建**。
   *
   * 表单 DSL 是一次性编译的（`renderFormDsl` 建控件、挂校验、算高度），没有"改一张表单"
   * 这种操作。而且一次 `collect_input` 对应一次中断，本来也不会连着来两张同样的表。
   */
  mountForm(dsl: unknown, toolCallId = ''): StageMountResult {
    let host: FormHost;
    try {
      host = new FormHost(dsl, this.cssWidth, toolCallId, this.options);
    } catch (err) {
      return { ok: false, diagnostics: (err as Error).message, kind: null, built: false };
    }

    this.__replace('form', host);
    this.builds.form++;
    this.show('form');
    return { ok: true, diagnostics: host.diagnostics, kind: 'form', built: true };
  }

  /**
   * 追加数据行（`STATE_DELTA` 的快路径）。
   *
   * @returns false 表示这批行走不了快路径（比如类目轴要补 `xAxis.data`），
   *          调用方应该拿 `state` 里的整份 DSL 走一次全量 `mountChart`。
   */
  appendRows(rows: any[][]): boolean {
    const host = this.layers.get('chart') as ChartHost | undefined;
    return host ? host.appendRows(rows) : false;
  }

  // -------------------------------------------------------------------------
  // 切面
  // -------------------------------------------------------------------------

  /**
   * 显示某个图层。
   *
   * 同时把**别的**按需图层收掉 —— 除了工艺图。理由是"按需图层留着也没用"：
   * 一次只有一种界面在前台，而图表 / 表单都是"这次 tool call 的产物"，
   * 下次来的时候本来就是整份新数据（图表会被 `setOption` 覆盖、表单会被重建），
   * 留着只是白占一块画布 + 一个 ICE 实例。
   *
   * 工艺图**不收** —— 它是这个应用的主视图，而且"切走再切回来不重画"正是需求里点名的。
   */
  show(kind: StageLayerKind): void {
    this.__measure();
    const host = this.layers.get(kind);
    if (!host) return;

    this.__dropOthers(kind);
    for (const [k, h] of this.layers) h.el.hidden = k !== kind;
    this.active = kind;
    this.shows[kind]++;
    // 先取消隐藏**再**量尺寸：display:none 的元素 clientWidth 是 0，
    // 顺序反了会画出一张 0 宽的图（这种错在 e2e 里表现为"canvas 存在但全白"）。
    host.fit(this.cssWidth, this.cssHeight);
    // 可视区跟上次不一样（多半是面板折叠状态变了）→ 重摆一次初始视野。
    // **没变就不动**：图层的视口是用户拖出来的，切一次图层就复位会很烦人 ——
    // 切走的目的是"看看别的"，切回来的期望是"还在刚才那个位置"。
    if (kind === 'diagram' && this.__syncDiagramRegion()) this.diagram()?.reframe();
  }

  activeKind(): StageLayerKind | null {
    return this.active;
  }

  // -------------------------------------------------------------------------
  // 对话里的动作 → 落到当前图层
  // -------------------------------------------------------------------------

  /** 「指着讲」。工艺图走自己的高亮，图表走悬停。 */
  pointAt(value: any, opts: { blink?: boolean } = {}): boolean {
    if (this.active === 'diagram') return this.diagram()?.pointAt(value, opts) ?? false;
    if (this.active === 'chart') return this.chart()?.pointAt(value) ?? false;
    return false;
  }

  clearPoint(): void {
    if (this.active === 'diagram') this.diagram()?.clearPoint();
    else if (this.active === 'chart') this.chart()?.clearPoint();
  }

  /**
   * 缩放视图（agent 的命令）。目前只有工艺图能响应。
   *
   * 图表**静默返回 false** 而不是报错：图表走的是 `ice-chart` 自己的 resize / 悬停路径，
   * 没有对等的"缩放视图"概念。为它编一个错误出来只会让 agent 以为自己说错了话。
   */
  zoomView(cmd: { direction: ZoomDirection; factor?: number; steps?: number; scale?: number }): boolean {
    if (this.active !== 'diagram') return false;
    return this.diagram()?.zoomBy(cmd) ?? false;
  }

  /** 整图适配（"看整张图纸"）。只有工艺图有这个概念。 */
  fitAll(): boolean {
    return this.diagram()?.fitAll() ?? false;
  }

  /**
   * 增量增删图元。**不重建图层、不重置视口** —— 这正是它存在的理由。
   *
   * @returns 实际动了几个图元；`null` 表示现在绘图区上不是工艺图
   *          （补丁落不到别的图层上，调用方应当退一次全量）。
   */
  patchDiagram(
    patch: {
      units?: any[];
      pipes?: any[];
      removedUnitIds?: string[];
      removedPipeIds?: string[];
    },
    patchedDoc?: any
  ): { added: number; removed: number } | null {
    const layer = this.diagram();
    if (!layer || this.active !== 'diagram') return null;
    // ⚠️ 内容指纹要跟着失效：不然下一次挂**同一份**（已经被补丁改过的）DSL 时，
    //    比对会命中旧指纹、以为"内容没变"，于是把那批增删静默吞掉。
    this.diagramKey = null;
    return layer.applyPatch(patch, patchedDoc);
  }

  /** 表单层：标记为已提交（界面侧的终态）。 */
  markFormSubmitted(): void {
    this.form()?.markSubmitted();
  }

  // -------------------------------------------------------------------------
  // 尺寸
  // -------------------------------------------------------------------------

  resize(): void {
    this.__measure();
    const w = this.cssWidth;
    const h = this.cssHeight;
    if (w <= 0 || h <= 0) return;

    for (const [kind, host] of this.layers) {
      if (kind === 'diagram') {
        // 只重排画布，**不重设视口** —— 那会把用户辛苦拖到的位置冲掉。
        // 初始视野只在 `viewportReady` 为 false 时设一次（见 DiagramLayer.fit）。
        (host as DiagramHost).layer.fit(w, h);
      } else {
        host.fit(w, h);
      }
    }

    if (this.__syncDiagramRegion()) this.diagram()?.reframe();
  }

  /**
   * 量一次绘图区自己的尺寸。返回尺寸是否变了。
   *
   * 为什么不靠调用方按顺序喂尺寸：`boot` 是先建舞台、再 `mountDiagram`，
   * 那时候还没人量过 — 而**初始视野只在第一次 fit 时设一次**，
   * 尺寸是 0 的话那一次就算错了（表现是"开页的图偏在一边"）。
   * 把测量放进每个入口，调用顺序就不再是承重的。
   */
  private __measure(): boolean {
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    if (w <= 0 || h <= 0) return false;
    const changed = w !== this.cssWidth || h !== this.cssHeight;
    this.cssWidth = w;
    this.cssHeight = h;
    return changed;
  }

  /**
   * 面板占了右边多少像素（0 = 折叠）。
   *
   * 为什么不用 `window.resize`：折叠面板**不会**触发 window resize，
   * 但会改变绘图区能用的宽度。所以这条得显式告诉舞台。
   */
  setPanelInset(px: number): void {
    this.__measure();
    const next = Math.max(0, Math.round(px));
    if (next === this.panelInset) return;
    this.panelInset = next;
    if (this.__syncDiagramRegion()) this.diagram()?.reframe();
  }

  // -------------------------------------------------------------------------
  // 调试口（e2e / 控制台用）
  // -------------------------------------------------------------------------

  /**
   * 当前活着的图层、各自建过几次 / 显示过几次。
   *
   * `builds` 是这次布局反转**最该被断言的那个数**：切到图表再切回来，
   * `builds.diagram` 必须还是 1 —— 那才叫"没重画"。
   */
  info(): {
    active: StageLayerKind | null;
    layers: StageLayerKind[];
    builds: Record<StageLayerKind, number>;
    shows: Record<StageLayerKind, number>;
    canvasCount: number;
    size: { width: number; height: number };
    panelInset: number;
  } {
    return {
      active: this.active,
      layers: Array.from(this.layers.keys()),
      builds: { ...this.builds },
      shows: { ...this.shows },
      canvasCount: this.root.querySelectorAll('canvas').length,
      size: { width: this.cssWidth, height: this.cssHeight },
      panelInset: this.panelInset,
    };
  }

  diagramStats(): { symbols: number; pipes: number; issues: Array<{ level: string; code: string; message: string; id?: string }> } | null {
    const layer = this.diagram();
    if (!layer) return null;
    const counts = layer.counts();
    return { symbols: counts.symbols, pipes: counts.pipes, issues: layer.issues() };
  }

  diagramPointedId(): string | null {
    return this.diagram()?.pointedId ?? null;
  }

  /**
   * 每个单元的**真实渲染包围盒**（世界坐标，含标签）。
   *
   * 为什么要这个口：`diagramStats()` 只回答"数量对不对"，`viewportInfo()` 只回答
   * "整张图有没有被裁到框外" —— **没有一个回答"图元之间有没有叠"**。
   * 而"叠"正是那种不会报错、校验也查不出（`validateWater()` 只管工艺语义）、
   * 只有人眼看得见的问题。量它只能靠真实盒子，不能从 DSL 的 `left/top` 加预设尺寸推：
   * `inline: false` 的符号把名字与位号画在盒子**外面**，实际占的比预设尺寸大一截。
   */
  diagramBoxes(): Array<{ id: string; kind: string; minX: number; minY: number; maxX: number; maxY: number }> | null {
    return this.diagram()?.nodeBoxes() ?? null;
  }

  /**
   * 每条管线的**标注盒**（`DN700 污水` 那类文字）。
   *
   * 单独一个口而不是并进 `diagramBoxes()`：单元的落墨盒与管线的标注盒是两类东西
   * （一个含形状，一个只有文字），判重叠时要分别对"自己这一类"和"另一类"都查一遍。
   */
  diagramEdgeLabels(): ReturnType<DiagramLayer['edgeLabelBoxes']> | null {
    return this.diagram()?.edgeLabelBoxes() ?? null;
  }

  diagramViewport(): ReturnType<DiagramLayer['viewportInfo']> | null {
    return this.diagram()?.viewportInfo() ?? null;
  }

  diagramZoom(): ReturnType<DiagramLayer['zoomInfo']> | null {
    return this.diagram()?.zoomInfo() ?? null;
  }

  diagramBlink(): ReturnType<DiagramLayer['blinkInfo']> | null {
    return this.diagram()?.blinkInfo() ?? null;
  }

  /** 控件条上各按钮的矩形。canvas 里没有 DOM 目标可定位。 */
  widgetRects(): Array<{ id: string; top: number; left: number; width: number; height: number }> {
    return this.chart()?.widgetRects() ?? [];
  }

  /** 表单提交按钮的**页面坐标**中心。canvas 里没有 DOM 目标可点击。 */
  formSubmitPoint(): { x: number; y: number } | null {
    return this.form()?.submitPoint() ?? null;
  }

  formValues(): Record<string, any> {
    return this.form()?.values() ?? {};
  }

  formFieldTexts(): Array<{ name: string; text: string | null }> {
    return this.form()?.fieldTexts() ?? [];
  }

  fillForm(values: Record<string, any>): boolean {
    const host = this.form();
    if (!host) return false;
    host.setValues(values);
    return true;
  }

  destroy(): void {
    for (const host of this.layers.values()) host.destroy();
    this.layers.clear();
    this.active = null;
    this.diagramKey = null;
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private diagram(): DiagramLayer | null {
    return (this.layers.get('diagram') as DiagramHost | undefined)?.layer ?? null;
  }

  private chart(): ChartHost | null {
    return (this.layers.get('chart') as ChartHost | undefined) ?? null;
  }

  private form(): FormHost | null {
    return (this.layers.get('form') as FormHost | undefined) ?? null;
  }

  /** 可视区：画布铺满，但右边 `panelInset` 那块被面板压住。 */
  private __region() {
    return {
      left: 0,
      top: 0,
      width: Math.max(1, this.cssWidth - this.panelInset),
      height: Math.max(1, this.cssHeight),
    };
  }

  private __syncDiagramRegion(): boolean {
    return this.diagram()?.setRegion(this.__region()) ?? false;
  }

  /** 换掉某一层：先把旧的从 DOM / 引擎里收干净，再挂新的。 */
  private __replace(kind: StageLayerKind, host: LayerHost): void {
    const prev = this.layers.get(kind);
    if (prev) {
      prev.destroy();
      prev.el.remove();
    }
    this.layers.set(kind, host);
    this.root.append(host.el);
  }

  /**
   * 收掉除 `keep` 与工艺图之外的按需图层。
   *
   * 工艺图单独豁免：它是主视图、永不销毁（切走再切回来是"显示"而不是"重建"，
   * 那正是需求里点名的"不用每次都重新绘制完整的工艺图"）。
   */
  private __dropOthers(keep: StageLayerKind): void {
    for (const kind of ['chart', 'form'] as StageLayerKind[]) {
      if (kind === keep) continue;
      const host = this.layers.get(kind);
      if (!host) continue;
      host.destroy();
      host.el.remove();
      this.layers.delete(kind);
    }
  }
}

// ---------------------------------------------------------------------------
// 三个图层宿主
// ---------------------------------------------------------------------------

/** 建一个 `.stage-layer` 根。 */
function layerEl(kind: StageLayerKind): HTMLElement {
  const el = document.createElement('div');
  el.className = 'stage-layer';
  el.dataset.kind = kind;
  el.hidden = true;
  return el;
}

/**
 * 工艺图的宿主。
 *
 * 构造里就完成 `fit` —— 初始视野是**按可视区尺寸**算出来的，两者必须在那之前就位
 * （`DiagramLayer` 的 `viewportReady` 只设一次，那一次算错就一直是错的）。
 * 所以视口区域要在 `fit` **之前**设进去，这就是第三个构造参数存在的理由。
 * 建不干净（引擎 / 设计器抛）就自己收尾再往外抛，由 `mountDiagram` 转成诊断。
 */
class DiagramHost implements LayerHost {
  readonly kind = 'diagram' as const;
  readonly el: HTMLElement;
  readonly layer: DiagramLayer;

  constructor(doc: any, cssWidth: number, cssHeight: number, region: DiagramRegion) {
    this.el = layerEl('diagram');
    this.layer = new DiagramLayer(doc);
    this.el.append(this.layer.canvas);
    try {
      // ⚠️ 顺序承重：setRegion 必须在 fit 之前
      this.layer.setRegion(region);
      // fit 要动画布与视口，是最可能出问题的一步。抛了就把刚建好的层收干净 ——
      // 半建成的层留着就是一张画布 + 一个 rAF 循环。
      this.layer.fit(cssWidth, cssHeight);
    } catch (err) {
      try {
        this.layer.destroy();
      } catch {
        /* 收尾失败不掩盖原始错误 */
      }
      throw err;
    }
  }

  fit(width: number, height: number): void {
    this.layer.fit(width, height);
  }

  destroy(): void {
    this.layer.destroy();
  }
}

/**
 * 图表的宿主：**两块画布**（图表 + 控件条），两个 ICE 实例。
 *
 * 为什么控件条不在图表那张画布上直接画：`ice-chart` 内部自己 `new ICE()`，
 * 不接受外部实例；硬塞只能走 `addMark`，而那是**按数据坐标**摆位的槽位
 * （适合"锚在异常点上的浮动按钮"），不适合"绘图区底部一条控件栏"。两种需求，两个层。
 *
 * 控件条挂在宿主**底部**（CSS `position:absolute; bottom:…`），也就是"浮在绘图区底部"。
 */
class ChartHost implements LayerHost {
  readonly kind = 'chart' as const;
  readonly el: HTMLElement;

  private readonly chartWrap: HTMLElement;
  private readonly widgetWrap: HTMLElement;
  private readonly adapter: ChartAdapter;
  private readonly widgetLayer: WidgetLayer | null;
  /** 图真画出来了才把控件条亮出来（校验没过的图表不该白占第二块画布）。 */
  private widgetShown = false;
  private cssWidth = 0;
  private cssHeight = 0;

  constructor(
    options: StageOptions,
    cssWidth: number,
    cssHeight: number,
    private readonly toolCallId: () => string
  ) {
    this.el = layerEl('chart');

    this.chartWrap = document.createElement('div');
    this.chartWrap.className = 'stage-chart';
    const chartCanvas = document.createElement('canvas');
    this.chartWrap.append(chartCanvas);
    // 图表的实例是 `createChart` 自己建的（上游缺口第 7 条），所以 `ChartAdapter` 里
    // 拿不到外部实例 —— 这是三个图层里唯一不能共用引擎的一个。
    this.adapter = new ChartAdapter(chartCanvas, options.handlers ?? {});

    this.widgetWrap = document.createElement('div');
    this.widgetWrap.className = 'stage-widget';
    this.widgetWrap.hidden = true;
    if (options.widgets) {
      const widgets = options.widgets;
      this.widgetLayer = new WidgetLayer(widgets.actions, {
        height: WIDGET_BAR_HEIGHT,
        onAction: (actionId) => widgets.onAction(actionId, this.toolCallId()),
      });
      this.widgetWrap.append(this.widgetLayer.canvas);
    } else {
      this.widgetLayer = null;
    }

    this.el.append(this.chartWrap, this.widgetWrap);
    this.fit(cssWidth, cssHeight);
  }

  /** 挂一份图表 DSL。校验没过时**不提交**（`ChartAdapter.mount` 在 `setOption` 之前就返回了）。 */
  mount(dsl: any): { ok: boolean; diagnostics: string | null } {
    const result = this.adapter.mount(dsl);
    if (!result.ok) return result;
    if (this.widgetLayer && !this.widgetShown) {
      this.widgetShown = true;
      this.widgetWrap.hidden = false;
    }
    this.fit(this.cssWidth, this.cssHeight);
    return result;
  }

  appendRows(rows: any[][]): boolean {
    return this.adapter.appendRows(rows);
  }

  pointAt(value: any): boolean {
    return this.adapter.pointAt(value);
  }

  clearPoint(): void {
    this.adapter.clearPoint();
  }

  widgetRects(): Array<{ id: string; top: number; left: number; width: number; height: number }> {
    return this.widgetLayer?.buttonRects() ?? [];
  }

  fit(width: number, height: number): void {
    if (width > 0 && height > 0) {
      this.cssWidth = width;
      this.cssHeight = height;
    }
    // 尺寸一律**问容器**，不在 JS 里重算一遍 CSS 的盒子 —— 那等于把布局抄一份，
    // 改一次 CSS 就得改一次 JS（控件条高度、间距、内边距全在里面）。
    const chartW = this.chartWrap.clientWidth;
    const chartH = this.chartWrap.clientHeight;
    if (chartW > 0 && chartH > 0) this.adapter.resize(chartW, chartH);
    if (this.widgetLayer) {
      const w = this.widgetWrap.clientWidth || this.cssWidth;
      if (w > 0) this.widgetLayer.fit(w);
    }
  }

  destroy(): void {
    this.widgetLayer?.destroy();
    this.adapter.destroy();
  }
}

/** 表单的宿主：一块居中浮在绘图区上的画布。 */
class FormHost implements LayerHost {
  readonly kind = 'form' as const;
  readonly el: HTMLElement;
  readonly diagnostics: string | null;

  private readonly wrap: HTMLElement;
  private readonly layer: FormLayer;
  private readonly cssWidth: number;

  constructor(dsl: any, cssWidth: number, toolCallId: string, options: StageOptions) {
    this.cssWidth = cssWidth;
    this.el = layerEl('form');
    this.wrap = document.createElement('div');
    this.wrap.className = 'stage-form';

    let diagnostics: string | null = null;
    this.layer = new FormLayer(dsl, this.__available(), {
      onDiagnostics: (text) => {
        diagnostics = text;
      },
      onSubmit: (values) => options.onFormSubmit?.(values, toolCallId),
    });
    this.diagnostics = diagnostics;

    this.wrap.append(this.layer.canvas);
    this.el.append(this.wrap);
    // 构造时还没进 DOM，`__available()` 拿到的多半是兜底值；`show()` 里那次 fit 会纠正。
    this.fit(cssWidth, 0);
  }

  fit(width: number, height: number): void {
    const w = this.__available() || width || this.cssWidth;
    if (w > 0) this.layer.fit(w);
  }

  submitPoint(): { x: number; y: number } | null {
    const rect = this.layer.submitRect();
    if (!rect) return null;
    // canvas 里没有 DOM 目标可点击，只能按引擎给的绝对原点 + 画布在页面里的位置算
    const box = this.layer.canvas.getBoundingClientRect();
    return { x: box.left + rect.left + rect.width / 2, y: box.top + rect.top + rect.height / 2 };
  }

  values(): Record<string, any> {
    return this.layer.values();
  }

  setValues(values: Record<string, any>): void {
    this.layer.setValues(values);
  }

  fieldTexts(): Array<{ name: string; text: string | null }> {
    return this.layer.fieldTexts();
  }

  markSubmitted(): void {
    this.layer.markSubmitted();
  }

  destroy(): void {
    this.layer.destroy();
  }

  /**
   * 表单能给多宽。
   *
   * ⚠️ 必须量**内容盒**，不能用 `clientWidth`：`clientWidth` **包含内边距**，
   * 而画布是 `display:block` 排在内容盒里的。用 `clientWidth` 的话
   * `fitCanvasToDisplaySize` 会把画布显式设成"比内容盒宽 `padding*2`"，
   * 直接溢出面板（表现是右边一截压在边框外面）。
   *
   * 量不到（构造时还没进 DOM）时退回一个保守值 ——
   * 反正 `fit()` 在 `show()` 里会立刻用真实宽度纠正一次。
   */
  private __available(): number {
    const wrap = this.wrap;
    const style = wrap.ownerDocument.defaultView?.getComputedStyle(wrap);
    const padL = parseFloat(style?.paddingLeft ?? '0') || 0;
    const padR = parseFloat(style?.paddingRight ?? '0') || 0;
    const inner = wrap.clientWidth - padL - padR;
    if (inner > 0) return inner;
    return Math.min(720, Math.max(320, this.cssWidth - 64));
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * DSL 的内容指纹。同一个 tool call 重发同一份数据时靠它认出"不用重建"。
 *
 * `JSON.stringify` 直接当指纹够用：这里的对象是**协议解析出来的纯数据**
 * （没有函数、没有循环、没有 Map/Set），而键序在同一个进程里是稳定的
 * —— 需要比对的两份来自同一段代码路径。
 * 序列化失败（理论上不会）返回 null，那样就退化成"每次都重建"，不会出错。
 */
function safeKey(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/** 图 DSL 的警告文本（校验通过但有话要说）。 */
function diagramWarnings(warnings: DiagramDiagnostic[]): string | null {
  if (!warnings.length) return null;
  return formatDiagramDiagnostics({ valid: true, errors: [], warnings });
}
