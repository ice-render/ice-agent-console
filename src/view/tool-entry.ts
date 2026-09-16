/**
 * **对话里的一条工具条目**：一次 tool call 的"回执"。
 *
 * 它**不再带画布** —— 图、图表、表单都画在绘图区（`src/view/stage.ts`），
 * 这里只留外壳：工具名、状态、流式参数原文、诊断、去向提示。
 *
 * ## 为什么不带画布（这是这次布局反转最核心的一刀）
 *
 * 旧结构是"一张卡片 = 一次 tool call"，卡片里装一块 canvas。那个结构下
 * **每来一次 tool call 就多一块画布 + 一个 ICE 实例**，而且"图"因此变成了消息流里的
 * 一个历史条目 —— "把刚才那张图放大"没有"刚才那张图"可指，只能又画一张。
 *
 * 现在绘图区只有一块画布区域，tool call 只是"让绘图区显示什么"的一次指令。
 * 条目上留下的东西正好回答三个问题：**谁**（工具名）、**怎么了**（状态与诊断）、
 * **去哪儿了**（提示：已渲染到绘图区）。
 *
 * ## 三个状态，对应协议里 tool call 的三个阶段
 *
 *   流式中   `TOOL_CALL_ARGS` 在来   →  显示正在拼装的参数原文（带光标）
 *   完成     `TOOL_CALL_END`         →  收起原文，提示"已渲染到绘图区"
 *   失败     校验不通过              →  保留原文 + 列出结构化诊断，并把诊断交出去回灌
 *
 * 失败态与已提交态都是**粘住**的：`update()` 在每条后续事件上都会被调用，
 * 不管一下的话 `STATE_SNAPSHOT`、`RUN_FINISHED` 会把状态冲成"已渲染"。
 */
import type { ToolItem } from '../domain/agui/reducer';

const STATUS_TEXT: Record<ToolItem['status'], string> = {
  streaming: '参数流式传输中…',
  'args-done': '参数拼装完成',
  result: '参数拼装完成',
};

export class ToolEntryView {
  readonly el: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly argsEl: HTMLElement;
  private readonly argsWrap: HTMLElement;
  private readonly diagEl: HTMLElement;
  private readonly hintEl: HTMLElement;

  private toolName = '';
  /** 已经成功上过绘图区：收起参数原文（保留"参数共 N 字节"这个线索）。 */
  private mounted = false;
  /**
   * 校验失败过。
   *
   * 需要这个标志是因为 `update()` 在**每条后续事件**上都会被调用，
   * 而它会重写状态文案和 `data-status` —— 不管一下的话，后续事件会把
   * "校验不通过" 冲成 "已渲染"，诊断还挂在上面但状态看着是成功的。
   */
  private failed = false;

  constructor(readonly toolCallId: string) {
    this.el = document.createElement('div');
    this.el.className = 'tool-entry';
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

    this.diagEl = document.createElement('ul');
    this.diagEl.className = 'diag';
    this.diagEl.hidden = true;

    this.hintEl = document.createElement('div');
    this.hintEl.className = 'hint';
    this.hintEl.hidden = true;

    body.append(this.argsWrap, this.diagEl, this.hintEl);
    this.el.append(head, body);
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

    // 已经上过绘图区就别再让参数原文占地方（保留字节数这个线索在提示里）
    if (this.mounted) return;

    this.argsEl.textContent = item.argsRaw;
    if (item.status === 'streaming') {
      const cursor = document.createElement('span');
      cursor.className = 'cursor';
      this.argsEl.append(cursor);
    }
  }

  /**
   * 上绘图区成功后的收尾：收起参数原文、亮出"去了哪儿"的提示。
   *
   * @param hintHtml 允许带标签（`<b>` / `<code>`）—— 调用方（boot）知道渲染的结果，
   *                 比如"68 个符号 + 81 段管线"，那些数字该被强调。
   */
  markMounted(hintHtml: string): void {
    this.mounted = true;
    this.failed = false;
    this.el.dataset.status = 'done';
    this.statusEl.textContent = '已渲染';
    this.argsWrap.hidden = true;
    this.diagEl.hidden = true;
    this.hintEl.hidden = false;
    this.hintEl.innerHTML = hintHtml;
  }

  /** 没上去（校验没过 / 建不出来）：保留原文并列出诊断。 */
  markFailed(statusText: string, diagnostics: string | null, asWarning = false): void {
    this.failed = !asWarning;
    if (!asWarning) {
      this.el.dataset.status = 'error';
      this.statusEl.textContent = statusText;
    }
    if (diagnostics) this.showDiagnostics(diagnostics, asWarning);
  }

  /** 表单已提交（界面侧的终态；归约器那边也记了，两边一致）。 */
  markSubmitted(): void {
    this.el.dataset.status = 'done';
    this.statusEl.textContent = '已提交';
  }

  /**
   * 标出"现在绘图区上显示的就是这一条"。
   *
   * 这是布局反转之后**唯一**能回答"图上这个是什么时候来的"的线索 ——
   * 旧结构靠卡片里那块画布，现在画布只有一块，所以要在条目上标出来。
   */
  setActive(on: boolean): void {
    if (on) this.el.dataset.active = 'true';
    else delete this.el.dataset.active;
  }

  showDiagnostics(text: string, asWarning = false): void {
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

  /** 这次 tool call 的工具名。自修复回路要知道"失败的是什么"。 */
  get tool(): string {
    return this.toolName;
  }
}
