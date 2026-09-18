/**
 * 把模型返回的 Markdown 渲染成**真 DOM 节点**。
 *
 * ## 为什么是 token → 节点，而不是 `innerHTML = md.render(...)`
 *
 * 模型说的话是**不可信输入**：它可能被用户的话带偏、可能复述网页内容、
 * 也可能只是自己写出一段 `<img onerror=…>`。markdown-it 默认就不放行原始 HTML
 * （`html: false`），但真正保证安全的不是那个开关，而是**这一层的写法**：
 * 全程 `createElement` / `textContent`，**没有一处 innerHTML**。
 * 于是"逃逸"不需要额外库来担保 —— 结构由我们的代码决定，模型只能决定文字。
 *
 * ## 为什么选 markdown-it
 *
 * ① 它同时提供 CJS 与 ESM 入口（这条不是小事：纯 ESM 的包会让 jest 那套 CJS 链路
 * 直接加载失败，而修法要么加 babel 转 node_modules、要么在测试里绕 —— 都是给后来人埋的坑）；
 * ② 零运行时依赖、MIT、仍在维护；③ `parse()` 给的是标准 token 流，正好适合自建 DOM。
 *
 * ## 流式
 *
 * 每来一个 delta 就整段重渲染（消息通常几 KB，够便宜）。半截标记不会抛异常：
 * `**还没闭合` 会退化成普通段落，没闭合的围栏会当成代码块 —— 都是合理的中间态。
 */
import MarkdownIt from 'markdown-it';

/** 允许出现在 `href` 上的协议。白名单而不是黑名单 —— 少一个 `javascript:` 就够致命。 */
const SAFE_URL = /^(https?:|mailto:)/i;

/**
 * `html: false` —— 原始 HTML 不解析（markdown-it 会把它当**文本**输出）。
 * `linkify: true` —— 模型给裸 URL 是常态，让它自动成链。
 * `breaks: true` —— 单个换行就断行：模型输出里换行是有意义的，按标准 Markdown
 * 折叠成空格会把它写好的要点挤成一坨。
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

/**
 * 块级 token 的开标签 → 元素名。不在这张表里的 `*_open` 一律当普通容器（div）。
 *
 * 标题**不在这张表里**：markdown-it 用同一个 `heading_open` 表示 h1~h6，
 * 层级在 `token.tag` 上。按类型查表会把 `## 标题` 也画成 h1 —— 或者像第一版那样
 * 直接查不到、当成 div，标题就没有任何视觉层级了。
 */
const BLOCK_TAGS: Record<string, string> = {
  paragraph_open: 'p',
  blockquote_open: 'blockquote',
  bullet_list_open: 'ul',
  ordered_list_open: 'ol',
  list_item_open: 'li',
  table_open: 'table',
  thead_open: 'thead',
  tbody_open: 'tbody',
  tr_open: 'tr',
  th_open: 'th',
  td_open: 'td',
};

/** 行内 token 的开标签 → 元素名。 */
const INLINE_TAGS: Record<string, string> = {
  strong_open: 'strong',
  em_open: 'em',
  s_open: 'del',
};

function readAttr(token: any, name: string): string | null {
  const attrs: any[] = Array.isArray(token.attrs) ? token.attrs : [];
  const hit = attrs.find((pair) => pair[0] === name);
  return hit ? String(hit[1]) : null;
}

/** 内外距/对齐这类属性照搬（表格的对齐就靠它）。 */
function applySafeAttrs(el: HTMLElement, token: any): void {
  const ol = el.tagName === 'OL' ? readAttr(token, 'start') : null;
  if (ol && Number.isFinite(Number(ol))) el.setAttribute('start', ol);
  const align = readAttr(token, 'style');
  if (align && /^text-align:\s*(left|center|right)$/.test(align)) el.setAttribute('style', align);
}

/** 造一个链接元素（不安全协议退化成纯文本 —— 内容不丢，只是不能点）。 */
function makeLink(href: string): HTMLElement {
  if (!SAFE_URL.test(href)) {
    return document.createElement('span');
  }
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  // `noopener`：不设的话，被打开的页面能通过 `window.opener` 反过来改我们这一页
  a.rel = 'noopener noreferrer';
  return a;
}

/** 行内 children → 节点（markdown-it 的行内也是 open/close 成对的）。 */
function renderInline(children: any[], parent: HTMLElement): void {
  const stack: HTMLElement[] = [parent];
  const top = () => stack[stack.length - 1];
  for (const token of children || []) {
    switch (token.type) {
      case 'text':
        top().append(document.createTextNode(token.content ?? ''));
        break;
      case 'code_inline': {
        const code = document.createElement('code');
        code.className = 'md-codespan';
        code.textContent = token.content ?? '';
        top().append(code);
        break;
      }
      case 'softbreak':
      case 'hardbreak':
        top().append(document.createElement('br'));
        break;
      case 'link_open':
        stack.push(makeLink(readAttr(token, 'href') ?? ''));
        break;
      case 'image': {
        // 图**不自动加载**：URL 是模型给的，加载等于把"我看了这张图"告诉对方的服务器。
        // 退化成一行可点的说明文字，用户想看再点。
        const alt = token.content || readAttr(token, 'src') || '';
        const link = makeLink(readAttr(token, 'src') ?? '');
        link.textContent = `🖼 ${alt}`;
        top().append(link);
        break;
      }
      default: {
        const tag = INLINE_TAGS[token.type];
        if (tag && token.nesting === 1) {
          stack.push(document.createElement(tag));
        } else if (token.nesting === -1) {
          const el = stack.pop() || document.createElement('span');
          top().append(el);
        } else if (token.type === 'html_inline') {
          // `html: false` 时通常不会走到这里；真走到就**当文字**，绝不变成元素
          top().append(document.createTextNode(token.content ?? ''));
        } else if (token.content) {
          top().append(document.createTextNode(token.content));
        }
      }
    }
  }
  // 半截输入理论上不会留下未闭合的栈；真留下就把它们收进父节点，别把内容丢了
  while (stack.length > 1) {
    const el = stack.pop() as HTMLElement;
    top().append(el);
  }
}

/**
 * 把 `src` 渲染进 `container`（**清空重建**）。
 *
 * 解析失败时退化成一整段纯文本 —— 宁可这一帧没有排版，也不能让消息整条消失。
 */
export function renderMarkdown(container: HTMLElement, src: string): void {
  container.textContent = '';
  if (!src) return;
  let tokens: any[] = [];
  try {
    tokens = md.parse(src, {});
  } catch {
    container.textContent = src;
    return;
  }
  try {
    // 块级也是 open/close 成对的，用一个栈落位；`inline` / `fence` / `hr` 是叶子。
    const stack: HTMLElement[] = [container];
    const top = () => stack[stack.length - 1];
    for (const token of tokens) {
      if (token.type === 'inline') {
        renderInline(token.children, top());
        continue;
      }
      if (token.type === 'fence' || token.type === 'code_block') {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        const lang = String(token.info || '').trim().split(/\s+/)[0];
        if (lang) code.className = `language-${lang}`;
        code.textContent = token.content ?? '';
        pre.append(code);
        top().append(pre);
        continue;
      }
      if (token.type === 'hr') {
        top().append(document.createElement('hr'));
        continue;
      }
      if (token.type === 'html_block') {
        top().append(document.createTextNode(token.content ?? ''));
        continue;
      }
      if (token.nesting === 1) {
        const tag = token.type === 'heading_open' ? token.tag : (BLOCK_TAGS[token.type] ?? 'div');
        const el = document.createElement(tag);
        applySafeAttrs(el, token);
        stack.push(el);
        continue;
      }
      if (token.nesting === -1) {
        const el = stack.pop();
        if (el && (el as any) !== container) top().append(el);
        continue;
      }
      if (token.content) top().append(document.createTextNode(token.content));
    }
    while (stack.length > 1) {
      const el = stack.pop() as HTMLElement;
      top().append(el);
    }
  } catch {
    container.textContent = src;
  }
}
