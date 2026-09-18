/**
 * 对话面板：**这一层是真 DOM，不是 canvas。**
 *
 * ice-web-components 的立场是 "every pixel drawn by the engine"，但它适合的是
 * 应用外壳、表单、弹窗这类"自成一体的画布界面"。这个面板不一样：
 * 消息要能选中复制、要能走输入法、要有浏览器原生的滚动惯性、要能被屏幕阅读器读。
 * 用 canvas 重做一遍只有坏处。
 *
 * 所以分界划在这儿：**DOM 管对话，canvas 管绘图区**（见 `src/view/stage.ts`）。
 *
 * 面板是 `position: fixed` **浮在绘图区右边缘上**的。一个必须做的动作：
 * 在面板根上 `stopPropagation` 掉指针 / 滚轮 / 点击事件 —— 见 `shieldFromCanvas`，
 * 由 `boot.ts` 在 `#chat`（**整个面板**，不只是消息区）上装一次。
 *
 * 渲染策略是"按 id 复用元素"而不是重绘整棵树 —— 因为条目上有状态机
 * （流式 / 已渲染 / 校验不通过 / 已提交），整棵重建会把"这一条已经失败过"这类
 * 粘性状态冲掉，也会把滚动位置弹回去。这一点决定了这里不能写成 `innerHTML = ...`。
 */
import type { ThreadState, TextItem, ToolItem, ReasoningItem } from '../domain/agui/reducer';
import { ToolEntryView } from './tool-entry';
import { renderMarkdown } from './markdown';
import { shieldFromCanvas } from './dom-shield';

// 面板整体要装的那道屏蔽：实现与理由搬到了 `dom-shield.ts`（绘图区的浮层也要用同一套），
// 这里再导出一次，是为了不动 `boot.ts` 的既有调用点。
export { shieldFromCanvas };

interface TextSlot {
  wrap: HTMLElement;
  bubble: HTMLElement;
  /** 上一次写进气泡的原文。流式文本每来一个 delta 就会调到这里，相同就跳过。 */
  lastText?: string;
}

/**
 * 距底部多少像素以内算"贴着底部"。
 *
 * 不是 0：`scrollTop` 在小数缩放下会是 `xxx.5`（`scrollHeight` / `clientHeight` 被取整过），
 * 拿 `=== 0` 判的话，明明在底部却被当成"用户翻上去了"，跟随会莫名其妙地失效。
 * 这个容差也是"往上滚一点点但本意仍是跟随"的边界 —— 8px 大约是一行文字的 1/3。
 */
const STICK_THRESHOLD_PX = 8;

export class ChatView {
  private readonly textSlots = new Map<string, TextSlot>();
  private readonly entries = new Map<string, ToolEntryView>();
  /** 思考过程块：按条目 id 复用（流式期间每个 delta 都会调到这里）。 */
  private readonly reasoningSlots = new Map<
    string,
    { wrap: HTMLDetailsElement; summary: HTMLElement; body: HTMLElement; lastLength: number; lastDone: boolean | null }
  >();
  private emptyEl: HTMLElement | null;

  /** 「这一轮失败了」那张提示卡。有错误时在，没有时移除。 */
  private errorEl: HTMLElement | null = null;
  /** 上一次渲染的 error 值，用来避免每帧重写 DOM。 */
  private lastError: string | null = null;
  /** 「正在思考」那一行。只在"run 在跑、但还什么都没有"时出现。 */
  private pendingEl: HTMLElement | null = null;

  /**
   * 是否**跟着底部**走。开页为 `true`（新会话就该盯着最新一条）。
   *
   * 这个标志是"自动滚动"能不能做成的前提：**一律滚到底**会让人没法往回读 ——
   * 你刚往上翻两屏去看前面那段解释，下一条流式文本就把你拽回底部了。
   * 所以跟随必须是**有条件的**：用户自己滚上去了就松手，滚回底部再自己接上。
   *
   * 判断放在 `scroll` 事件里（而不是在渲染时比位置），是因为只有那个事件
   * 才分得清"位置是用户改的"还是"我们自己改的"—— 我们滚到底之后也会触发一次，
   * 而那时距底部是 0，判定结果自然还是"跟随"，不用额外打标记。
   */
  private stickToBottom = true;

  /** `scroll` 的监听器，`destroy()` 时要摘掉。 */
  private readonly onScroll = () => {
    this.stickToBottom = this.__distanceFromBottom() <= STICK_THRESHOLD_PX;
  };

  constructor(private readonly root: HTMLElement) {
    this.emptyEl = root.querySelector('.empty');
    // `passive: true`：这个监听只读位置、不阻止滚动，声明出来能让浏览器少一次等待
    this.root.addEventListener('scroll', this.onScroll, { passive: true });
  }

  render(state: ThreadState): void {
    if (state.items.length > 0 && this.emptyEl) {
      this.emptyEl.remove();
      this.emptyEl = null;
    }

    // 按顺序落位。归约器只往 items 末尾追加，所以正常情况下 DOM 顺序天然一致；
    // 这里仍然按游标校正一次，代价极低，但能兜住"以后有人在中间插入条目"的情况。
    let cursor = 0;
    for (const item of state.items) {
      const el =
        item.kind === 'text'
          ? this.renderText(item)
          : item.kind === 'tool'
            ? this.renderTool(item)
            : this.renderReasoning(item);
      const at = this.root.children[cursor] ?? null;
      if (at !== el) this.root.insertBefore(el, at);
      cursor++;
    }

    // 错误提示**挂在消息流末尾**（在 `__followIfSticking` 之前，这样跟随滚动会把它带进视野）。
    // 成功之后要收掉：`state.error` 归约器只在 RUN_ERROR 时置位，下一轮成功不会自动清，
    // 所以这里以"当前 error 值"为准，变了就重画、空了就移除。
    if (state.error !== this.lastError) {
      this.lastError = state.error;
      if (state.error) this.__renderErrorNotice(state.error);
      else if (this.errorEl) {
        this.errorEl.remove();
        this.errorEl = null;
      }
    }

    // 「正在思考」：**run 在跑、但助手这一侧还一条都没有**的时候才显示。
    // 本地模型（尤其是带 reasoning 的）首答可能要一两分钟，没有这一行的话，
    // 用户看到的就是"我发了一句话，然后什么都没有"。
    // 一旦任何助手内容到了（文字或工具卡）就撤掉 —— 那时进度已经在内容里了。
    this.__renderPending(state.status === 'running' && !this.__hasAssistantContent(state));

    // ⚠️ 必须在**写完 DOM 之后**才滚：上面那些 insertBefore / textContent 会改变内容高度，
    //    提前滚的话滚到的是**旧**的 scrollHeight，于是一屏永远差一截。
    //    这里读 `scrollHeight` 会触发一次同步布局 —— 换来的正是不用等下一帧。
    this.__followIfSticking();
  }

  /** 某次 tool call 的条目 —— 上绘图区成功后要往它上面写"去了哪儿"。 */
  entry(toolCallId: string): ToolEntryView | undefined {
    return this.entries.get(toolCallId);
  }

  /**
   * 标出"绘图区上现在显示的就是这一条"，其它条目全部清掉标记。
   *
   * 传 `null` 表示绘图区上什么都没有（比如挂了之后又失败），那就全清。
   */
  markActive(toolCallId: string | null): void {
    for (const [id, entry] of this.entries) entry.setActive(id === toolCallId);
  }

  destroy(): void {
    this.root.removeEventListener('scroll', this.onScroll);
    this.entries.clear();
    this.textSlots.clear();
    this.reasoningSlots.clear();
  }

  private renderText(item: TextItem): HTMLElement {
    let slot = this.textSlots.get(item.id);
    if (!slot) {
      const wrap = document.createElement('div');
      wrap.className = `msg ${item.role === 'user' ? 'user' : 'assistant'}`;
      wrap.dataset.messageId = item.id;

      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = item.role === 'user' ? '我' : 'AI';

      const bubble = document.createElement('div');
      bubble.className = 'bubble';

      wrap.append(who, bubble);
      slot = { wrap, bubble };
      this.textSlots.set(item.id, slot);
    }
    /**
     * 流式文本每次整段重写：片段拼接的状态在归约器里，这里只负责显示。
     *
     * - **助手**走 Markdown（`renderMarkdown` 自己建节点，全程没有 innerHTML）；
     * - **用户**保持纯文本原样 —— 用户敲进来的星号就是星号，不该被排版规则吃掉。
     */
    const text = item.text || '';
    if (slot.lastText !== text) {
      slot.lastText = text;
      if (item.role === 'user') slot.bubble.textContent = text;
      else renderMarkdown(slot.bubble, text);
    }
    return slot.wrap;
  }

  /**
   * **本轮**助手这一侧有没有已经到手的可见内容（文字 / 工具卡 / 思考过程）。
   *
   * ⚠️ 判据必须是"最后一条用户消息**之后**"的那些条目，不能扫整个 thread ——
   * 历史里只要出现过一次工具卡（几乎必然），`some()` 就永远为真，
   * 于是新一轮的「正在思考」再也不会出现。这个 bug 在单测里看不出来
   * （单测的 state 是干净的），是在真实回放里发现的：连发两轮，第二轮全程没有等待提示。
   */
  private __hasAssistantContent(state: ThreadState): boolean {
    const items = state.items;
    let from = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === 'text' && (items[i] as TextItem).role === 'user') {
        from = i + 1;
        break;
      }
    }
    return items.slice(from).some((item) => {
      if (item.kind === 'tool') return true;
      // 思考过程也算"有内容"：它一到，等待就从"转圈"变成"看得见它在想"，
      // 那一行「正在思考」就该让位（否则同一件事被说两遍）。
      if (item.kind === 'reasoning') return !!item.text;
      return item.role !== 'user' && !!item.text;
    });
  }

  /**
   * 显示 / 收起「正在思考」那一行。
   *
   * 复用同一个元素而不是每帧重建：重建会让 CSS 动画从头开始，
   * 于是等待期间三个点一直在"重新起步"，看起来像卡住了 —— 动画本身要有连续性。
   */
  private __renderPending(show: boolean): void {
    if (!show) {
      if (this.pendingEl) {
        this.pendingEl.remove();
        this.pendingEl = null;
      }
      return;
    }
    if (!this.pendingEl) {
      const el = document.createElement('div');
      el.className = 'msg assistant pending';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');

      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = 'AI';

      const bubble = document.createElement('div');
      bubble.className = 'bubble pending-bubble';
      const label = document.createElement('span');
      label.className = 'pending-label';
      label.textContent = '正在思考';
      const dots = document.createElement('span');
      dots.className = 'pending-dots';
      dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
      bubble.append(label, dots);

      el.append(who, bubble);
      this.pendingEl = el;
    }
    // 永远贴在最后（错误提示排在它后面，两者实际不会同时出现：报错意味着 run 结束了）
    this.root.append(this.pendingEl);
    if (this.errorEl) this.root.append(this.errorEl);
  }

  /**
   * 把"这一轮失败了"**画在对话流里**。
   *
   * ## 为什么不能只靠顶栏那行小字
   *
   * `state.error` 一直存在，原先只拼进顶栏的 meta（`… · 工具 0 · 出错 · Failed to fetch`）。
   * 那行字又小又挤，而失败这件事是**用户发了一句话之后什么都没发生**：
   * 面板里只有他自己那条消息，看上去就像"AI 不理我"。实测过 ——
   * 打开静态站点加 `?demo=0`（于是走后端 transport，而那个站点上没有后端），
   * 点任意一个按钮，画面就停在这个状态：图还在、顶栏角落写着 "Failed to fetch"、
   * 对话里一片空白。
   *
   * ## 文案为什么带上 `?demo=1`
   *
   * 最常见的失败场景就是"演示站点上把开关关掉了"（或者分享了带 `?demo=0` 的链接）。
   * 这时候真正有用的信息只有一句话：**改用纯前端**。
   * 原始报错（`Failed to fetch` / CORS）照样显示在下面一行 —— 它是给开发者看的，
   * 不能藏起来，不然本地真配错了就查不出原因。
   */
  private __renderErrorNotice(message: string): void {
    if (!this.errorEl) {
      const el = document.createElement('div');
      el.className = 'error-notice';
      el.setAttribute('role', 'alert');

      const title = document.createElement('div');
      title.className = 'error-title';
      title.textContent = '这一轮没能连上 agent';

      const hint = document.createElement('div');
      hint.className = 'error-hint';
      // 纯文本，不走 innerHTML —— 这句话里提到了查询参数，别让它有机会变成标记
      hint.textContent =
        '当前页面走的是「连后端」那条路，而这里没有后端在跑。' +
        '如果这是静态演示站点，用 ?demo=1 改成纯前端（内置剧本，不需要后端）。';

      const detail = document.createElement('div');
      detail.className = 'error-detail';

      el.append(title, hint, detail);
      this.root.append(el);
      this.errorEl = el;
    }
    const detail = this.errorEl.lastElementChild as HTMLElement;
    if (detail.textContent !== message) detail.textContent = message;
  }

  private renderTool(item: ToolItem): HTMLElement {
    let entry = this.entries.get(item.id);
    if (!entry) {
      entry = new ToolEntryView(item.id);
      this.entries.set(item.id, entry);
    }
    entry.update(item);
    return entry.el;
  }

  /**
   * 模型的思考过程：一条**默认收起**的弱化块。
   *
   * 为什么用 `<details>` 而不是自己写开关：键盘、屏幕阅读器、折叠动画它都免费给了，
   * 而这个面板里有大量原生语义（可选中、可复制、有 aria）—— 自己造一个只会更差。
   *
   * 自动折叠的规则只有一条：**思考进行中展开、结束时收起**。
   * 只在状态**变化的那一次**写 `open` —— 每帧都写会把用户手动展开/收起的操作顶掉
   * （他刚点开想看细节，下一个 delta 又给合上了）。
   */
  private renderReasoning(item: ReasoningItem): HTMLElement {
    let slot = this.reasoningSlots.get(item.id);
    if (!slot) {
      const wrap = document.createElement('details');
      wrap.className = 'reasoning';
      wrap.dataset.messageId = item.id;
      const summary = document.createElement('summary');
      const body = document.createElement('div');
      body.className = 'reasoning-body';
      wrap.append(summary, body);
      slot = { wrap, summary, body, lastLength: -1, lastDone: null };
      this.reasoningSlots.set(item.id, slot);
    }
    if (slot.lastDone !== item.done) {
      slot.lastDone = item.done;
      slot.wrap.open = !item.done;
      slot.summary.textContent = item.done ? '思考过程（点击展开）' : '正在思考…';
    }
    if (slot.lastLength !== item.text.length) {
      slot.lastLength = item.text.length;
      slot.body.textContent = item.text;
    }
    return slot.wrap;
  }

  /** 距底部还有多少像素。内容比容器矮时是负数 —— 那也算"贴底"。 */
  private __distanceFromBottom(): number {
    return this.root.scrollHeight - this.root.scrollTop - this.root.clientHeight;
  }

  /**
   * 把视图跟到最新一条。
   *
   * **瞬时跳**，不用 `behavior: 'smooth'`：流式文本每秒会调到这里十几次，
   * 平滑动画每次都还没跑完就被下一次打断，结果是**永远落在内容后面**（看着像卡住）。
   * 跟随要的是"始终贴底"，不是"优雅地滚过去"。
   */
  private __followIfSticking(): void {
    if (!this.stickToBottom) return;
    // 赋值会被浏览器夹到合法范围（内容不够长时自然停在 0），不用自己算 max
    this.root.scrollTop = this.root.scrollHeight;
  }
}
