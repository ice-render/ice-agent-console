/**
 * Thread 外壳：**这一层是真 DOM，不是 canvas。**
 *
 * ice-web-components 的立场是 "every pixel drawn by the engine"，但它适合的是
 * 应用外壳、表单、弹窗这类"自成一体的画布界面"。这个界面不一样：
 * 消息要能选中复制、要能走输入法、要有浏览器原生的滚动惯性、要能被屏幕阅读器读。
 * 用 canvas 重做一遍只有坏处。
 *
 * 所以分界划在这儿：**DOM 管 thread 外壳，canvas 管卡片内容（图表）**。
 *
 * 渲染策略是"按 id 复用元素"而不是重绘整棵树——因为卡片里有 canvas，
 * 重绘会把图表实例连带销毁掉。这一点决定了这里不能写成 `innerHTML = ...`。
 */
import type { ThreadState, TextItem, ToolItem } from '../domain/agui/reducer';
import type { InteractionHandlers } from './chart-adapter';
import { CardView } from './card';

interface TextSlot {
  wrap: HTMLElement;
  bubble: HTMLElement;
}

export class ThreadView {
  private readonly textSlots = new Map<string, TextSlot>();
  private readonly cards = new Map<string, CardView>();
  private emptyEl: HTMLElement | null;

  constructor(
    private readonly root: HTMLElement,
    /** 上行通道的回调。每张图表卡片创建时都会挂上它。 */
    private readonly handlers: InteractionHandlers = {}
  ) {
    this.emptyEl = root.querySelector('.empty');
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
    let card = this.cards.get(item.id);
    if (!card) {
      card = new CardView(item.id, this.handlers);
      this.cards.set(item.id, card);
    }
    card.update(item);
    return card.el;
  }

  /** 最后一张图表卡片——`STATE_DELTA` 和「指着讲」的作用对象。 */
  lastCard(): CardView | undefined {
    for (let i = this.root.children.length - 1; i >= 0; i--) {
      const el = this.root.children[i] as HTMLElement;
      const id = el.dataset?.toolCallId;
      if (id) {
        const card = this.cards.get(id);
        if (card?.mounted) return card;
      }
    }
    return undefined;
  }

  card(toolCallId: string): CardView | undefined {
    return this.cards.get(toolCallId);
  }

  resizeAll(): void {
    for (const card of this.cards.values()) card.resize();
  }

  destroy(): void {
    for (const card of this.cards.values()) card.destroy();
    this.cards.clear();
    this.textSlots.clear();
  }
}
