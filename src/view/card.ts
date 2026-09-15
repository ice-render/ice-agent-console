/**
 * 一张卡片 = 一次 tool call。（前面定下来的粒度：跟协议的事件边界重合，
 * 归约器不用额外切分。）
 *
 * 卡片的三个形态，正好对应协议里 tool call 的三个阶段：
 *
 *   流式中   TOOL_CALL_ARGS 在来   →  显示正在拼装的参数原文（带光标）
 *   完成     TOOL_CALL_END         →  按**工具名**分派：图表 / 表单 / 图 → 校验 → 上画布
 *   失败     校验不通过            →  保留原文 + 列出结构化诊断，并把诊断交出去回灌
 *
 * ## 按工具名分派
 *
 * `render_chart` 出图表卡、`collect_input` 出表单卡、`render_diagram` 出图卡。
 * **加一种卡片只是加一个工具名** —— 归约器与时间线完全不用动，
 * 这正是"一张卡片 = 一次 tool call"这个粒度的好处。
 * （在此之前 CardView 硬编码 `ChartAdapter`，卡片承载不了非图表内容。）
 *
 * 三个形态都是"卡片内容"，都画在自己的 canvas 上、各自一个 ICE 实例；
 * 而卡片外壳（标题、状态、诊断、参数原文）始终是真 DOM。
 */
import { COLLECT_INPUT_TOOL, RENDER_DIAGRAM_TOOL } from '../../shared/contract';
import type { ToolItem } from '../domain/agui/reducer';
import { ChartAdapter, type InteractionHandlers } from './chart-adapter';
import { DiagramLayer } from './diagram-layer';
import { FormLayer } from './form-layer';
import { WidgetLayer, type WidgetAction } from './widget-layer';
import { formatDiagramDiagnostics, validateDiagramDsl } from '../domain/diagram/validate';

const STATUS_TEXT: Record<ToolItem['status'], string> = {
  streaming: '参数流式传输中…',
  'args-done': '已渲染',
  result: '已渲染',
};

/** 图表卡片底部的 canvas 控件条配置。 */
export interface CardWidgets {
  actions: WidgetAction[];
  onAction: (actionId: string, toolCallId: string) => void;
  height?: number;
}

export interface CardOptions {
  /** 图表卡的控件条。不传就不建。 */
  widgets?: CardWidgets;
  /** 表单卡提交（且校验通过）时回调。 */
  onFormSubmit?: (values: Record<string, any>, toolCallId: string) => void;
}

export class CardView {
  readonly el: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly argsEl: HTMLElement;
  private readonly argsWrap: HTMLElement;
  private readonly chartWrap: HTMLElement;
  private readonly formWrap: HTMLElement;
  private readonly diagramWrap: HTMLElement;
  private readonly diagEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly adapter: ChartAdapter;

  private readonly widgetWrap: HTMLElement;
  private readonly options: CardOptions;
  /**
   * 控件层**惰性创建**：它是第二个 ICE 实例 + 第二张画布，只有真画出图来的卡片才需要。
   * 校验没通过的卡片（比如自修复那轮的坏 DSL）不该白占一个实例。
   */
  private widgetLayer: WidgetLayer | null = null;

  /** 表单层，同样惰性创建。与控件层互斥（图表卡才有控件条）。 */
  private formLayer: FormLayer | null = null;

  /** 图层，同样惰性创建。与图表 / 表单三者互斥：一次 tool call 只有一个形态。 */
  private diagramLayer: DiagramLayer | null = null;

  /** 当前这次 tool call 的工具名 —— `mount()` 靠它决定渲染成哪种卡片。 */
  private toolName = '';

  private renderedDsl: any = null;
  /**
   * 校验失败过。
   *
   * 需要这个标志是因为 `update()` 在**每条后续事件**上都会被调用，
   * 而它会重写状态文案和 `data-status`——不管一下的话，
   * `STATE_SNAPSHOT`、`RUN_FINISHED` 这些后续事件会把 `mount()` 设好的
   * "校验不通过" 冲成 "已渲染"，诊断还挂在上面但状态看着是成功的。
   */
  private failed = false;

  constructor(
    readonly toolCallId: string,
    handlers: InteractionHandlers = {},
    options: CardOptions = {}
  ) {
    this.options = options;

    this.el = document.createElement('div');
    this.el.className = 'card';
    this.el.dataset.toolCallId = toolCallId;
    this.el.dataset.status = 'streaming';

    const head = document.createElement('div');
    head.className = 'card-head';

    const dot = document.createElement('span');
    dot.className = 'dot';

    this.titleEl = document.createElement('span');
    this.titleEl.className = 'title';

    this.statusEl = document.createElement('span');
    this.statusEl.className = 'status';

    head.append(dot, this.titleEl, this.statusEl);

    const body = document.createElement('div');
    body.className = 'card-body';

    this.argsWrap = document.createElement('div');
    this.argsEl = document.createElement('pre');
    this.argsEl.className = 'args';
    this.argsWrap.append(this.argsEl);

    // 图表层：卡片里的第一块画布。
    this.chartWrap = document.createElement('div');
    this.chartWrap.className = 'chart-wrap';
    this.chartWrap.hidden = true;
    const canvas = document.createElement('canvas');
    this.chartWrap.append(canvas);

    // 表单层：跟图表层**互斥**——一次 tool call 要么是图表要么是表单。
    this.formWrap = document.createElement('div');
    this.formWrap.className = 'form-wrap';
    this.formWrap.hidden = true;

    // 图层：与前两者**互斥**——第三种卡片形态（`render_diagram`）。
    this.diagramWrap = document.createElement('div');
    this.diagramWrap.className = 'diagram-wrap';
    this.diagramWrap.hidden = true;

    // 控件层：图表卡底部的控件条，跟图表**并排**的另一块画布。
    this.widgetWrap = document.createElement('div');
    this.widgetWrap.className = 'widget-wrap';
    this.widgetWrap.hidden = true;

    this.diagEl = document.createElement('ul');
    this.diagEl.className = 'diag';
    this.diagEl.hidden = true;

    this.hintEl = document.createElement('div');
    this.hintEl.className = 'hint';
    this.hintEl.hidden = true;

    body.append(
      this.argsWrap,
      this.chartWrap,
      this.formWrap,
      this.diagramWrap,
      this.widgetWrap,
      this.diagEl,
      this.hintEl
    );
    this.el.append(head, body);

    this.adapter = new ChartAdapter(canvas, handlers);
  }

  /** 同步流式状态。每次归约后调用。 */
  update(item: ToolItem): void {
    this.toolName = item.name;
    this.titleEl.textContent = item.name;
    this.el.dataset.tool = item.name;

    if (item.submitted) {
      // 表单已提交：这是终态，后续事件不许把它冲掉
      this.el.dataset.status = 'done';
      this.statusEl.textContent = '已提交';
      return;
    }

    if (this.failed) {
      // 已经是失败态：后续事件不许把它冲掉
      this.el.dataset.status = 'error';
      this.statusEl.textContent = '校验不通过';
      return;
    }

    this.statusEl.textContent = STATUS_TEXT[item.status] ?? item.status;
    this.el.dataset.status = item.status === 'streaming' ? 'streaming' : 'done';

    // 画布已经出来了就别再让参数原文占地方，收起来（保留字节数这个线索）
    if (this.renderedDsl !== null) return;

    this.argsEl.textContent = item.argsRaw;
    if (item.status === 'streaming') {
      const cursor = document.createElement('span');
      cursor.className = 'cursor';
      this.argsEl.append(cursor);
    }
  }

  /** 上画布。校验失败时保留原文并列出诊断，把诊断文本返回给调用方回灌。 */
  mount(dsl: unknown): { ok: boolean; diagnostics: string | null } {
    if (this.toolName === COLLECT_INPUT_TOOL) return this.mountForm(dsl);
    if (this.toolName === RENDER_DIAGRAM_TOOL) return this.mountDiagram(dsl);
    return this.mountChart(dsl);
  }

  private mountChart(dsl: unknown): { ok: boolean; diagnostics: string | null } {
    const result = this.adapter.mount(dsl);
    if (!result.ok) {
      this.failed = true;
      this.el.dataset.status = 'error';
      this.statusEl.textContent = '校验不通过';
      this.showDiagnostics(result.diagnostics);
      return result;
    }

    this.failed = false;
    this.renderedDsl = dsl;
    this.chartWrap.hidden = false;
    // 先取消隐藏再 resize：display:none 的元素 clientWidth 是 0，
    // 顺序反了会画出一张 0 宽的图（这种错在 e2e 里表现为"canvas 存在但全白"）。
    this.adapter.resize();

    // 图出来了才把控件层建出来（惰性）—— 第二块画布、第二个 ICE 实例
    this.ensureWidgetLayer();

    this.argsWrap.hidden = true;
    this.diagEl.hidden = true;
    this.hintEl.hidden = false;
    this.hintEl.innerHTML =
      `参数共 <b>${JSON.stringify(dsl).length}</b> 字节，分片流式传完；` +
      `已编译为 ICE 图表并挂到同一个实例上；` +
      `下方控件条是<b>另一张画布</b>（第二个 ICE 实例，` +
      `由 <code>ice-web-components</code> 绘制）。`;
    if (result.diagnostics) {
      this.showDiagnostics(result.diagnostics, true);
    }
    return result;
  }

  /**
   * 表单卡：参数是一份**表单 DSL**，交给 `ice-web-components-dsl` 画。
   *
   * 校验也由那份 DSL 负责（它的 `validateFormDsl` 同样不抛异常、同样给结构化诊断），
   * 所以这里的错误处理与图表卡完全同形 —— 诊断回灌那条自修复回路不用改一行。
   */
  private mountForm(dsl: unknown): { ok: boolean; diagnostics: string | null } {
    const available = this.formWrap.parentElement?.clientWidth || 420;
    let diagnostics: string | null = null;

    try {
      this.formLayer = new FormLayer(dsl, available, {
        onDiagnostics: (text) => {
          diagnostics = text;
        },
        onSubmit: (values) => this.options.onFormSubmit?.(values, this.toolCallId),
      });
    } catch (err) {
      this.failed = true;
      this.el.dataset.status = 'error';
      this.statusEl.textContent = '校验不通过';
      const text = (err as Error).message;
      this.showDiagnostics(text);
      return { ok: false, diagnostics: text };
    }

    this.failed = false;
    this.renderedDsl = dsl;
    this.formWrap.append(this.formLayer.canvas);
    this.formWrap.hidden = false;
    // 同图表卡：先取消隐藏再量尺寸（display:none 时量到 0）
    this.formLayer.fit(available);

    this.argsWrap.hidden = true;
    this.diagEl.hidden = true;
    this.hintEl.hidden = !diagnostics;
    if (diagnostics) {
      this.showDiagnostics(diagnostics, true);
      this.hintEl.textContent = '表单 DSL 有警告（仍已渲染）';
    }
    return { ok: true, diagnostics };
  }

  /**
   * 图卡：参数是一份**图 DSL**（kind-first），交给 `ice-entity-designer` 画。
   *
   * 与另两张卡片的差别：这个 DSL 的守卫是**自己**的（`src/domain/diagram/`），
   * 因为上游的 `ice-entity-designer-dsl` 目前没有 water 编译器。
   * 校验同样**永不抛**、同样给结构化诊断 —— 于是自修复回路那条路一行都不用改。
   *
   * 校验放在**建画布之前**：不通过就一块 canvas 都不建，只把诊断列出来。
   * 这比"建了再拆"干净（拆不干净就是一张画布 + 一个 rAF 循环留着）。
   */
  private mountDiagram(dsl: unknown): { ok: boolean; diagnostics: string | null } {
    const result = validateDiagramDsl(dsl);
    if (!result.valid) {
      this.failed = true;
      this.el.dataset.status = 'error';
      this.statusEl.textContent = '校验不通过';
      const text = formatDiagramDiagnostics(result);
      this.showDiagnostics(text);
      return { ok: false, diagnostics: text };
    }

    let layer: DiagramLayer;
    try {
      layer = new DiagramLayer(dsl as any);
      this.diagramWrap.append(layer.canvas);
      // 同图表卡：先取消隐藏再量尺寸（display:none 时 clientWidth 是 0，
      // 顺序反了会把画布量成 0 宽，表现为"canvas 存在但全白"）
      this.diagramWrap.hidden = false;
      // fit 必须在 try 里：它要动画布与视口，是最可能出问题的一步。
      // 漏在外面的话异常会一路冒到事件处理里，变成整轮 RUN_ERROR ——
      // 那样连诊断都回灌不了，用户只看到"出错了"。
      layer.fit(this.diagramWrap.clientWidth, this.diagramWrap.clientHeight);
    } catch (err) {
      // 校验过了但视图层仍然抛（引擎 / 设计器 / 画布尺寸）：同样走诊断回灌。
      // 先收干净再报错 —— 半建成的层留着就是一张画布 + 一个 rAF 循环。
      try {
        (layer as any)?.destroy();
      } catch {
        /* 收尾失败不掩盖原始错误 */
      }
      this.diagramLayer = null;
      this.diagramWrap.hidden = true;
      this.failed = true;
      this.el.dataset.status = 'error';
      this.statusEl.textContent = '渲染失败';
      const text = `[错误] 建图失败：${(err as Error).message}`;
      this.showDiagnostics(text);
      return { ok: false, diagnostics: text };
    }
    this.diagramLayer = layer;

    this.failed = false;
    this.renderedDsl = dsl;

    const counts = layer.counts();
    this.argsWrap.hidden = true;
    this.diagEl.hidden = true;
    this.hintEl.hidden = false;
    this.hintEl.innerHTML =
      `参数共 <b>${JSON.stringify(dsl).length}</b> 字节，分片流式传完；` +
      `已编译为 <b>${counts.symbols}</b> 个符号 + <b>${counts.pipes}</b> 段管线（第三个 ICE 实例，` +
      `由 <code>ice-entity-designer</code> 绘制）。滚轮缩放、空白处拖拽平移。`;
    const warnings = formatDiagramDiagnostics({ valid: true, errors: [], warnings: result.warnings });
    if (warnings) {
      this.showDiagnostics(warnings, true);
    }
    return { ok: true, diagnostics: warnings };
  }

  /**
   * 建控件层并摆好。只在第一次上画布成功时建。
   *
   * 顺序跟图表一样是"**先取消隐藏、再 fit**"：`display:none` 时父容器 `clientWidth` 为 0，
   * 反了就会把这一层量成 0 宽。
   */
  private ensureWidgetLayer(): void {
    if (!this.options.widgets) return;
    const widgets = this.options.widgets;

    if (!this.widgetLayer) {
      this.widgetLayer = new WidgetLayer(widgets.actions, {
        height: widgets.height,
        onAction: (actionId) => widgets.onAction(actionId, this.toolCallId),
      });
      this.widgetWrap.append(this.widgetLayer.canvas);
    }
    this.widgetWrap.hidden = false;

    const available = this.widgetWrap.clientWidth || 640;
    this.widgetLayer.fit(available);
  }

  appendRows(rows: any[][]): boolean {
    return this.adapter.appendRows(rows);
  }

  /** 控件条上各按钮的矩形（CSS 像素）。没建控件层就返回空数组。 */
  widgetRects(): Array<{ id: string; top: number; left: number; width: number; height: number }> {
    return this.widgetLayer?.buttonRects() ?? [];
  }

  /**
   * 表单卡提交按钮的**页面坐标**中心。
   *
   * 给 e2e 用：canvas 里没有 DOM 目标可点击，只能按引擎给的绝对原点 + 画布在页面里的位置算。
   * 没建表单层或没有提交按钮时返回 null。
   */
  formSubmitPoint(): { x: number; y: number } | null {
    const rect = this.formLayer?.submitRect();
    if (!rect) return null;
    const box = this.formLayer!.canvas.getBoundingClientRect();
    return { x: box.left + rect.left + rect.width / 2, y: box.top + rect.top + rect.height / 2 };
  }

  /** 表单卡：各字段当前画出来的文字（调试 / e2e 用）。 */
  formFieldTexts(): Array<{ name: string; text: string | null }> {
    return this.formLayer?.fieldTexts() ?? [];
  }

  /** 表单卡：当前各字段的值（调试 / e2e 用）。 */
  formValues(): Record<string, any> {
    return this.formLayer?.values() ?? {};
  }

  /** 表单卡：批量写入字段值。返回是否确实是一张表单卡。 */
  fillForm(values: Record<string, any>): boolean {
    if (!this.formLayer) return false;
    this.formLayer.setValues(values);
    return true;
  }

  /**
   * 表单卡：标记为已提交。
   *
   * 界面侧的终态（按钮禁用、文案改掉）；模型侧还有一层 —— 校验不过本来就提交不了。
   * 归约器那边也记了 `submitted`，所以后续事件不会把这个状态冲掉。
   */
  markFormSubmitted(): void {
    this.formLayer?.markSubmitted();
  }

  pointAt(value: any): boolean {
    // 图卡走自己的高亮（引擎没有通用的高亮原语，见 diagram-layer 的注释）
    if (this.diagramLayer) return this.diagramLayer.pointAt(value);
    return this.adapter.pointAt(value);
  }

  clearPoint(): void {
    if (this.diagramLayer) {
      this.diagramLayer.clearPoint();
      return;
    }
    this.adapter.clearPoint();
  }

  resize(): void {
    if (this.renderedDsl === null) return;
    if (this.diagramLayer) {
      // 只重排画布，**不重设视口** —— 那会把用户辛苦拖到的位置冲掉
      this.diagramLayer.fit(this.diagramWrap.clientWidth, this.diagramWrap.clientHeight);
      return;
    }
    if (this.formLayer) {
      this.formLayer.fit(this.formWrap.clientWidth || 420);
      return;
    }
    this.adapter.resize();
    if (this.widgetLayer) {
      this.widgetLayer.fit(this.widgetWrap.clientWidth || 640);
    }
  }

  get mounted(): boolean {
    // 图卡也要算进来：`ThreadView.lastCard()` 按这个标志往回找，
    // 漏了它会让 `point-at` 落到**上一张图表卡**上（静默错目标）
    return this.adapter.mounted || this.formLayer !== null || this.diagramLayer !== null;
  }

  get isForm(): boolean {
    return this.formLayer !== null;
  }

  /** 这次 tool call 的工具名。自修复回路要知道"是哪张卡失败了"。 */
  get tool(): string {
    return this.toolName;
  }

  /** 图卡：符号 / 管线条数与工艺校验结果（调试 / e2e 用）。不是图卡就返回 null。 */
  diagramStats(): { symbols: number; pipes: number; issues: Array<{ level: string; code: string; message: string; id?: string }> } | null {
    if (!this.diagramLayer) return null;
    const counts = this.diagramLayer.counts();
    return { symbols: counts.symbols, pipes: counts.pipes, issues: this.diagramLayer.issues() };
  }

  /** 图卡：当前被「指着讲」高亮的单元 id。 */
  diagramPointedId(): string | null {
    return this.diagramLayer ? this.diagramLayer.pointedId : null;
  }

  /** 图卡：视口与内容屏幕范围（调试 / e2e 用；断言"fit 生效且没被裁"）。 */
  diagramViewport(): ReturnType<DiagramLayer['viewportInfo']> | null {
    return this.diagramLayer ? this.diagramLayer.viewportInfo() : null;
  }

  private showDiagnostics(text: string | null, asWarning = false): void {
    if (!text) return;
    this.diagEl.hidden = false;
    this.diagEl.innerHTML = '';
    for (const line of text.split('\n').filter(Boolean)) {
      const li = document.createElement('li');
      if (asWarning) li.className = 'warn';
      li.textContent = line;
      this.diagEl.append(li);
    }
  }

  destroy(): void {
    // 三张画布、三个 ICE 实例都要收：漏掉图层/表单层/控件层就是一张画布 + 一个 rAF 循环留着
    this.diagramLayer?.destroy();
    this.diagramLayer = null;
    this.formLayer?.destroy();
    this.formLayer = null;
    this.widgetLayer?.destroy();
    this.widgetLayer = null;
    this.adapter.destroy();
  }
}
