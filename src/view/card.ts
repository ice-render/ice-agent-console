/**
 * 一张卡片 = 一次 tool call。（这是前面定下来的粒度：跟协议的事件边界重合，
 * 归约器不用额外切分。）
 *
 * 卡片的三个形态，正好对应协议里 tool call 的三个阶段：
 *
 *   流式中   TOOL_CALL_ARGS 在来   →  显示正在拼装的 DSL 原文（带光标）
 *   完成     TOOL_CALL_END         →  校验 → 上画布
 *   失败     校验不通过            →  保留原文 + 列出结构化诊断，并把诊断交出去回灌
 *
 * 那个"正在拼装"的形态是这个工程想证明的东西之一：AG-UI 让你能看到**参数在传**，
 * 而不是像多数工具调用界面那样只能转个圈。
 */
import type { ToolItem } from '../domain/agui/reducer';
import { ChartAdapter, type InteractionHandlers } from './chart-adapter';
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

export class CardView {
  readonly el: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly argsEl: HTMLElement;
  private readonly argsWrap: HTMLElement;
  private readonly canvasWrap: HTMLElement;
  private readonly diagEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly adapter: ChartAdapter;

  private readonly widgetWrap: HTMLElement;
  private readonly widgets: CardWidgets | undefined;
  /**
   * 控件层**惰性创建**：它是第二个 ICE 实例 + 第二张画布，只有真画出图来的卡片才需要。
   * 校验没通过的卡片（比如自修复那轮的坏 DSL）不该白占一个实例。
   */
  private widgetLayer: WidgetLayer | null = null;

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
    widgets?: CardWidgets
  ) {
    this.widgets = widgets;

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

    // 图表层：卡片里的第一块画布。跟下面控件层的 class 对称，便于 e2e 精确定位到"哪一块"。
    this.canvasWrap = document.createElement('div');
    this.canvasWrap.className = 'chart-wrap';
    this.canvasWrap.hidden = true;
    const canvas = document.createElement('canvas');
    this.canvasWrap.append(canvas);

    this.diagEl = document.createElement('ul');
    this.diagEl.className = 'diag';
    this.diagEl.hidden = true;

    // 控件层：跟图表**并排**的另一块画布，不是画在同一张上。
    // 引擎的模型是「一层 = 一个实例 + 一张画布」，图表又不接受外部实例，
    // 所以这里就是第二张 canvas。层与层互不重叠，不需要视口同步 / 输入穿透。
    this.widgetWrap = document.createElement('div');
    this.widgetWrap.className = 'widget-wrap';
    this.widgetWrap.hidden = true;

    this.hintEl = document.createElement('div');
    this.hintEl.className = 'hint';
    this.hintEl.hidden = true;

    body.append(this.argsWrap, this.canvasWrap, this.widgetWrap, this.diagEl, this.hintEl);
    this.el.append(head, body);

    this.adapter = new ChartAdapter(canvas, handlers);
  }

  /** 同步流式状态。每次归约后调用。 */
  update(item: ToolItem): void {
    this.titleEl.textContent = item.name;

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
    this.canvasWrap.hidden = false;
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
   * 建控件层并摆好。只在第一次上画布成功时建。
   *
   * 顺序跟图表一样是"**先取消隐藏、再 fit**"：`display:none` 时父容器 `clientWidth` 为 0，
   * 反了就会把这一层量成 0 宽。
   */
  private ensureWidgetLayer(): void {
    if (!this.widgets) return;

    if (!this.widgetLayer) {
      this.widgetLayer = new WidgetLayer(this.widgets.actions, {
        height: this.widgets.height,
        onAction: (actionId) => this.widgets!.onAction(actionId, this.toolCallId),
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
  widgetRects(): Array<{ id: string; left: number; top: number; width: number; height: number }> {
    return this.widgetLayer?.buttonRects() ?? [];
  }

  pointAt(value: any): boolean {
    return this.adapter.pointAt(value);
  }

  clearPoint(): void {
    this.adapter.clearPoint();
  }

  resize(): void {
    if (this.renderedDsl !== null) {
      this.adapter.resize();
      if (this.widgetLayer) {
        this.widgetLayer.fit(this.widgetWrap.clientWidth || 640);
      }
    }
  }

  get mounted(): boolean {
    return this.adapter.mounted;
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
    // 两张画布、两个 ICE 实例都要收：漏掉控件层就是一张画布 + 一个 rAF 循环留着
    this.widgetLayer?.destroy();
    this.widgetLayer = null;
    this.adapter.destroy();
  }
}
