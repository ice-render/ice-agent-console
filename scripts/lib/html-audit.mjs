/**
 * 从一份 HTML 原文里读出 TDK / 爬虫相关的字段。
 *
 * **为什么单独一个模块**：读它的有两个脚本，而且两边必须按同一把尺子量 ——
 *
 *   · `scripts/deploy-pages.mjs`：对**构建产物**（`dist/index.html`）做发版前自检；
 *   · `scripts/seo-check.mjs`：对**线上站点**做定期体检。
 *
 * 两份"我抄你一份"的解析在第一次改判据时就会漂（漂的方式还是静默的：
 * 一个说通过、另一个说失败）。所以规则只写在这里，两边都 import。
 *
 * ⚠️ 这里全是**正则**，不是 DOM 解析器：要解析的是**压缩过的产物**
 * （`<meta name=description content="...">` 这种省引号的写法），
 * 而且只用得上几个字段。够用，且零依赖 —— 别为了这几个字段引一个 HTML 解析库。
 */

/** 剥掉 `<!-- -->`：注释里会出现 `<a href>`、`<lastmod>` 这种"看起来像标签"的散文，
 *  不剥的话正则会把它当成真标记数进去（这个坑踩过两次）。 */
export const stripComments = (html) => String(html).replace(/<!--[\s\S]*?-->/g, '');

/** 从一段标签属性文本里取属性值（产物里引号可能被省掉，所以三种写法都认）。 */
export const attr = (raw, key) => {
  const re = new RegExp(`(?:^|\\s)${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = String(raw).match(re);
  return m ? m[1] ?? m[2] ?? m[3] ?? null : null;
};

/** 按 `name=` 或 `property=` 取一个 meta 的 content。 */
export const meta = (html, kind, key) => {
  const tags = [...String(html).matchAll(/<meta\s[^>]*>/gi)].map((m) => m[0]);
  const hit = tags.find((t) => (attr(t, kind) || '').toLowerCase() === key.toLowerCase());
  return hit ? attr(hit, 'content') : null;
};

export const title = (html) => (String(html).match(/<title>([^<]*)<\/title>/) || [])[1] || null;

/** `<link rel=canonical href=...>`（属性顺序与引号都不假设）。 */
export const canonical = (html) => {
  const tag = String(html).match(/<link[^>]*rel=["']?canonical["']?[^>]*>/i);
  return tag ? attr(tag[0], 'href') : null;
};

/**
 * 展示宽度：一个全角字按 2 算。
 *
 * 搜索结果的标题 / 摘要按**像素宽度**截断，而中文一个字顶两个西文字符。
 * 这个换算在 description 上踩过一次：158 个字符看着"没超 160"，
 * 换算下来约 316 个半角宽，是显示上限（约 155）的两倍 —— 后半句根本露不出来。
 */
export const displayWidth = (s) =>
  [...String(s)].reduce((n, ch) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1), 0);

/** 去掉标签、压掉空白 —— "爬虫能读到的正文"就是这个。 */
export const tagText = (s) => String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

/** 取某个 `<section id=...>` 的可读文本（文字替身就是靠它判的）。 */
export const sectionText = (html, id) => {
  const m = String(html).match(
    new RegExp(`<section[^>]*id=["']?${id}["']?[\\s\\S]*?</section>`, 'i')
  );
  return m ? tagText(m[0]) : '';
};

/**
 * 整份 HTML 的**可读正文**（`#site-summary` 那份替身 + 面板里的可见文案）。
 *
 * ⚠️ 必须先把 `<script>` / `<style>` 的内容整段去掉再数。第一版没去，
 * 于是内联 CSS（~7 KB）与 JSON-LD 被当成了"正文"，量出来 11912 字符 ——
 * 而真实数字是 **1799**（改之前只有 199）。差别不是"多算了一点"：
 * 阈值是 ≥1200，多算的 7 KB 让这条检查**永远绿**，就算有人把整段文字替身删掉也一样。
 * 一个永远不会红的检查比没有检查更糟。
 */
export const bodyText = (html) =>
  tagText(
    stripComments(String(html))
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  );

/** JSON-LD 的 `@graph`（解析失败直接抛 —— "写了但读不到"必须响亮）。 */
export const jsonLdGraph = (html) => {
  const m = String(html).match(/<script type=["']?application\/ld\+json["']?>([\s\S]*?)<\/script>/i);
  if (!m) throw new Error('没有 application/ld+json');
  return JSON.parse(m[1])['@graph'] || [];
};

/** 取 `<footer>` 里那排出站链接（面板底部的家族链接）。 */
export const footerLinks = (html) => {
  const footer = (String(html).match(/<footer>[\s\S]*?<\/footer>/) || [])[0] || '';
  return [...stripComments(footer).matchAll(/<a\b[^>]*>/gi)].map((m) => ({
    tag: m[0],
    href: attr(m[0], 'href'),
  }));
};
