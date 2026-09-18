/**
 * @jest-environment jsdom
 */
/**
 * Markdown 渲染：**结构对不对** + **不可信输入会不会变成可执行的东西**。
 *
 * 第二条是重点。模型说的话来自不可信输入（用户的话、它复述的网页内容、它自己编的标签），
 * 而 `marked` 从 v5 起明确不负责消毒 —— 所以这里不测"marked 会不会消毒"，
 * 而是测**我们的渲染器有没有把模型的文字变成 HTML**：全程 `createElement`，
 * 任何标记都只该以文字形式出现。
 */
import { renderMarkdown } from '../src/view/markdown';

function render(src: string): HTMLElement {
  const el = document.createElement('div');
  renderMarkdown(el, src);
  return el;
}

describe('Markdown 渲染', () => {
  it('段落 / 粗体 / 斜体 / 行内代码 → 对应的 DOM 节点', () => {
    const el = render('这句话有 **粗体**、*斜体* 和 `code`。');
    expect(el.querySelector('p')).not.toBeNull();
    expect(el.querySelector('strong')?.textContent).toBe('粗体');
    expect(el.querySelector('em')?.textContent).toBe('斜体');
    expect(el.querySelector('code')?.textContent).toBe('code');
    expect(el.textContent).toContain('这句话有 粗体、斜体 和 code。');
  });

  it('标题 / 列表 / 代码块 / 引用 / 分隔线', () => {
    const el = render(
      ['## 标题', '', '- 一', '- 二', '', '1. 甲', '2. 乙', '', '```js', 'const a = 1;', '```', '', '> 引用', '', '---'].join('\n')
    );
    expect(el.querySelector('h2')?.textContent).toBe('标题');
    expect(Array.from(el.querySelectorAll('ul li')).map((li) => li.textContent)).toEqual(['一', '二']);
    expect(Array.from(el.querySelectorAll('ol li')).map((li) => li.textContent)).toEqual(['甲', '乙']);
    // 围栏代码块的内容自带结尾换行（markdown-it 的原样内容），`pre` 里显示无差别
    expect(el.querySelector('pre code')?.textContent).toContain('const a = 1;');
    expect(el.querySelector('pre code')?.className).toContain('language-js');
    expect(el.querySelector('blockquote')?.textContent).toContain('引用');
    expect(el.querySelector('hr')).not.toBeNull();
  });

  it('链接加 target 与 rel（不带 rel 的话新页面能反过来改我们的标签页）', () => {
    const el = render('见 [文档](https://example.com/a)。');
    const a = el.querySelector('a') as HTMLAnchorElement;
    expect(a.href).toBe('https://example.com/a');
    expect(a.target).toBe('_blank');
    expect(a.rel).toBe('noopener noreferrer');
  });

  it('不安全协议不外链（退化成纯文本，内容不丢）', () => {
    const el = render('[点我](javascript:alert(1))');
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).toContain('点我');
  });

  it('★ 原始 HTML 当文字显示，绝不变成元素（模型输出是不可信输入）', () => {
    const el = render('<img src=x onerror="window.__pwned=1">\n\n<script>window.__pwned=2</script>');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('script')).toBeNull();
    expect((window as any).__pwned).toBeUndefined();
    expect(el.textContent).toContain('onerror');
  });

  it('表格渲染成 table（模型的对比结论经常是表格）', () => {
    const el = render(['| 项 | 值 |', '| --- | --- |', '| A | 1 |'].join('\n'));
    expect(el.querySelector('table')).not.toBeNull();
    expect(Array.from(el.querySelectorAll('th')).map((th) => th.textContent)).toEqual(['项', '值']);
    expect(Array.from(el.querySelectorAll('td')).map((td) => td.textContent)).toEqual(['A', '1']);
  });

  it('流式半截标记不炸：未闭合的粗体 / 未闭合的代码围栏 / 空串', () => {
    expect(() => render('**还没闭合')).not.toThrow();
    expect(render('**还没闭合').textContent).toContain('还没闭合');
    expect(() => render('```js\nconst a =')).not.toThrow();
    expect(render('').textContent).toBe('');
  });

  it('重复渲染会清空上一次的内容（流式是整段重写）', () => {
    const el = document.createElement('div');
    renderMarkdown(el, '第一段');
    renderMarkdown(el, '第二段');
    expect(el.textContent).toBe('第二段');
    expect(el.querySelectorAll('p')).toHaveLength(1);
  });
});
