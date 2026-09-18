/**
 * @jest-environment jsdom
 */
/**
 * 对话面板的两条**新近行为**（本地模型很慢才加的那两条）：
 *
 * ① 「正在思考」只在"run 在跑、助手侧还什么都没有"时出现 —— 一旦有内容就到岗下班，
 *    否则它会在正文旁边一直转圈，看起来像还有第二个任务在跑；
 * ② 助手气泡走 Markdown、用户气泡保持纯文本原样（用户敲的星号就是星号）。
 */
import { ChatView } from '../src/view/chat';
import type { ThreadState } from '../src/domain/agui/reducer';

function stateOf(patch: Partial<ThreadState>): ThreadState {
  return {
    threadId: 't1',
    runId: 'r1',
    status: 'idle',
    items: [],
    ...patch,
  } as ThreadState;
}

function mount(): { root: HTMLElement; view: ChatView } {
  const root = document.createElement('div');
  document.body.append(root);
  return { root, view: new ChatView(root) };
}

describe('「正在思考」那一行', () => {
  it('running + 助手侧什么都没有 → 出现；带了 aria-live（屏幕阅读器要知道它在等）', () => {
    const { root, view } = mount();
    view.render(stateOf({ status: 'running', items: [{ kind: 'text', id: 'u1', role: 'user', text: '看看图', done: true }] }));
    const pending = root.querySelector('.pending') as HTMLElement;
    expect(pending).not.toBeNull();
    expect(pending.getAttribute('role')).toBe('status');
    expect(pending.textContent).toContain('正在思考');
  });

  it('助手文字一到就撤掉（同一件事不说两遍）', () => {
    const { root, view } = mount();
    const user = { kind: 'text' as const, id: 'u1', role: 'user', text: '看看图', done: true };
    view.render(stateOf({ status: 'running', items: [user] }));
    expect(root.querySelector('.pending')).not.toBeNull();
    view.render(
      stateOf({
        status: 'running',
        items: [user, { kind: 'text', id: 'a1', role: 'assistant', text: '我来画', done: false }],
      })
    );
    expect(root.querySelector('.pending')).toBeNull();
  });

  it('思考过程开始流之后也撤掉（等待已经有了可见的进度）', () => {
    const { root, view } = mount();
    const user = { kind: 'text' as const, id: 'u1', role: 'user', text: '看看图', done: true };
    view.render(stateOf({ status: 'running', items: [user] }));
    expect(root.querySelector('.pending')).not.toBeNull();
    view.render(
      stateOf({
        status: 'running',
        items: [user, { kind: 'reasoning', id: 'reason_r1_0', phase: 0, text: '先想一下…', done: false }],
      })
    );
    expect(root.querySelector('.pending')).toBeNull();
  });

  it('流式期间复用同一个元素（重建会让三个点一直重新起步，看起来像卡住）', () => {
    const { root, view } = mount();
    const user = { kind: 'text' as const, id: 'u1', role: 'user', text: '看看图', done: true };
    view.render(stateOf({ status: 'running', items: [user] }));
    const first = root.querySelector('.pending');
    view.render(stateOf({ status: 'running', items: [user] }));
    expect(root.querySelector('.pending')).toBe(first);
  });

  /**
   * ★ 这条是**在真实回放里抓到的** bug：判断"本轮有没有内容"时扫了整个 thread，
   * 于是历史里只要出现过一张工具卡（几乎必然），新一轮的等待提示就再也不会出现。
   * 单测状态干净时看不出来，连发两轮才暴露。
   */
  it('历史里有工具卡，也不影响新一轮显示「正在思考」', () => {
    const { root, view } = mount();
    view.render(
      stateOf({
        status: 'running',
        items: [
          { kind: 'text', id: 'u1', role: 'user', text: '看看图', done: true },
          { kind: 'tool', id: 't1', name: 'render_diagram', argsRaw: '{}', status: 'result' },
          { kind: 'text', id: 'a1', role: 'assistant', text: '画好了', done: true },
          // ↓ 新一轮：只发了话，助手侧还没有任何内容
          { kind: 'text', id: 'u2', role: 'user', text: '那再看看销量', done: true },
        ],
      })
    );
    expect(root.querySelector('.pending')).not.toBeNull();
  });
});

describe('气泡渲染', () => {
  it('助手气泡把 Markdown 渲染成节点，用户气泡保持纯文本', () => {
    const { root, view } = mount();
    view.render(
      stateOf({
        status: 'idle',
        items: [
          { kind: 'text', id: 'u1', role: 'user', text: '**这不是加粗**', done: true },
          { kind: 'text', id: 'a1', role: 'assistant', text: '这是**加粗**', done: true },
        ],
      })
    );
    const user = root.querySelector('.msg.user .bubble') as HTMLElement;
    const assistant = root.querySelector('.msg.assistant .bubble') as HTMLElement;
    expect(user.querySelector('strong')).toBeNull();
    expect(user.textContent).toBe('**这不是加粗**');
    expect(assistant.querySelector('strong')?.textContent).toBe('加粗');
  });

  it('同一段文字重复渲染不重建节点（流式每个 delta 都调 render）', () => {
    const { root, view } = mount();
    const item = { kind: 'text' as const, id: 'a1', role: 'assistant', text: '一样的话', done: false };
    view.render(stateOf({ status: 'running', items: [item] }));
    const p = root.querySelector('.bubble p');
    view.render(stateOf({ status: 'running', items: [item] }));
    expect(root.querySelector('.bubble p')).toBe(p);
  });
});
