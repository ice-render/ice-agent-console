/**
 * 一张卡片 = 一次 tool call。（前面定下来的粒度：跟协议的事件边界重合，
 * 归约器不用额外切分。）
 *
 * 卡片的三个形态，正好对应协议里 tool call 的三个阶段：
 *
 *   流式中   TOOL_CALL_ARGS 在来   →  显示正在拼装的参数原文（带光标）
 *   完成     TOOL_CALL_END         →  按**工具名**分派：图表 / 表单 → 校验 → 上画布
 *   失败     校验不通过            →  保留原文 + 列出结构化诊断，并把诊断交出去回灌
 *
 * ## 按工具名分派
 *
 * `render_chart` 出图表卡、`collect_input` 出表单卡。**加一种卡片只是加一个工具名** ——
 * 归约器与时间线完全不用动，这正是"一张卡片 = 一次 tool call"这个粒度的好处。
 * （在此之前 CardView 硬编码 `ChartAdapter`，卡片承载不了非图表内容。）
 *
 * 两个形态都是"卡片内容"，都画在自己的 canvas 上、各自一个 ICE 实例；
 * 而卡片外壳（标题、状态、诊断、参数原文）始终是真 DOM。
 */
import { COLLECT_INPUT_TOOL } from '../../shared/contract';
import type { ToolItem } from '../domain/agui/reducer';
import { ChartAdapter, type InteractionHandlers } from './chart-adapter';
import { FormLayer } from './form-layer';
import { WidgetLayer, type WidgetAction } from './widget-layer';

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

    body.append(this.argsWrap, this.chartWrap, this.formWrap, this.widgetWrap, this.diagEl, this.hintEl);
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
    return this.toolName === COLLECT_INPUT_TOOL ? this.mountForm(dsl) : this.mountChart(dsl);
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
    return this.adapter.pointAt(value);
  }

  clearPoint(): void {
    this.adapter.clearPoint();
  }

  resize(): void {
    if (this.renderedDsl === null) return;
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
    return this.adapter.mounted || this.formLayer !== null;
  }

  get isForm(): boolean {
    return this.formLayer !== null;
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
    // 两张画布、两个 ICE 实例都要收：漏掉控件层/表单层就是一张画布 + 一个 rAF 循环留着
    this.formLayer?.destroy();
    this.formLayer = null;
    this.widgetLayer?.destroy();
    this.widgetLayer = null;
    this.adapter.destroy();
  }
}
