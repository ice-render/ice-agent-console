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
 * 在面板根上 `stopPropagation` 掉指针 / 滚轮 / 点击事件 —— 见 `__shieldFromCanvas`。
 *
 * 渲染策略是"按 id 复用元素"而不是重绘整棵树 —— 因为条目上有状态机
 * （流式 / 已渲染 / 校验不通过 / 已提交），整棵重建会把"这一条已经失败过"这类
 * 粘性状态冲掉，也会把滚动位置弹回去。这一点决定了这里不能写成 `innerHTML = ...`。
 */
import type { ThreadState, TextItem, ToolItem } from '../domain/agui/reducer';
import { ToolEntryView } from './tool-entry';

interface TextSlot {
  wrap: HTMLElement;
  bubble: HTMLElement;
}

/**
 * 引擎会**广播**这些事件给每一个 ICE 实例（`DOMEventInterceptor` 在 `window` 上
 * 挂的是冒泡阶段的监听），唯一的过滤是"事件目标是不是另一块 **canvas**"。
 * 对话面板是个 `<div>`，不在过滤范围内 —— 在面板上滚一下，画布那个实例照样会
 * 当成一次滚轮缩放。所以在面板根上把它们拦下来。
 *
 * **不拦键盘**：输入框一直是这样工作的，拦了输入法就废了。
 */
const SHIELDED_EVENTS = [
  'pointerdown',
  'pointerup',
  'pointermove',
  'pointercancel',
  'mousedown',
  'mouseup',
  'mousemove',
  'click',
  'dblclick',
  'auxclick',
  'wheel',
];

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
  private emptyEl: HTMLElement | null;

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
    this.__shieldFromCanvas();
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
      const el = item.kind === 'text' ? this.renderText(item) : this.renderTool(item);
      const at = this.root.children[cursor] ?? null;
      if (at !== el) this.root.insertBefore(el, at);
      cursor++;
    }

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
    // 流式文本每次整段写。片段拼接的状态在归约器里，这里只负责显示。
    const text = item.text || (item.done ? '' : '…');
    if (slot.bubble.textContent !== text) slot.bubble.textContent = text;
    return slot.wrap;
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

  private __shieldFromCanvas(): void {
    const stop = (event: Event) => event.stopPropagation();
    for (const name of SHIELDED_EVENTS) this.root.addEventListener(name, stop);
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
