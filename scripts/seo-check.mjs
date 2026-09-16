#!/usr/bin/env node
/**
 * 线上 SEO / 爬虫可见性体检 —— `npm run seo:check`
 *
 * ## 为什么需要它（而不是"发版脚本已经自检过了"）
 *
 * 发版脚本的自检看的是**这一次构建出来的产物**；这个脚本看的是**线上现在是什么**。
 * 两者差着一条时间线，而且这条线上有两件真实发生过的事：
 *
 *   1. **站点是构建产物，不跟 `main` 走。** 改完源码、提交、推送，`gh-pages` 还是旧的那一份
 *      （本仓踩过：源码推完以为"已经上线了"，其实线上还是上一版）。
 *   2. **下一次部署会把站点整个覆盖。** `--force` 推一整份新产物 —— 哪天有人从别的分支
 *      / 另一台机器发一次版，TDK 那三件套就可能悄悄回到旧状态，而构建日志是绿的。
 *
 * 所以"改完就算了"是不够的，得有个**随时能对着线上跑一遍**的东西。
 * 它不替代 Google Search Console（收录 / 排名只有那边知道），它管的是
 * **"我们能不能被爬"** 这一层。
 *
 * ## 用法
 *
 * ```bash
 * npm run seo:check                      # 打默认的演示站点
 * CONSOLE_URL=http://127.0.0.1:8100/ npm run seo:check   # 打本地静态产物
 * npm run seo:check -- --no-links        # 跳过外站链接探活（离线 / 不想等）
 * npm run seo:check -- --proxy           # 所有请求都走 ICE_HTTPS_PROXY
 * ```
 *
 * 外站探活（那 7 个 GitHub 仓库链接）走 `ICE_HTTPS_PROXY`，默认 `http://127.0.0.1:7890` ——
 * 与 `deploy-pages.mjs` 同一个约定（本机直连 github 不通）。
 *
 * ⚠️ **为什么要有 `--proxy`**：国内直连 github.io 的握手时间实测在 0.1s～19s 之间抖
 * （三次采样 19.4s / 3.7s / 8.5s），而走本机代理是 **0.32s**。
 * 不加这个开关时脚本直连站点、只在探外站链接时用代理 —— 网络抖大了会误报"连不上"，
 * 而误报会训练人去忽略这个脚本（那比没有脚本更糟）。所以连不上时给的是
 * **一句可执行的提示**（加 `--proxy` 再跑），不是一句"失败"。
 *
 * ## 判据的两条原则
 *
 * - **能硬判的硬判**（缺了就是缺了：HTTP 码、标签在不在、地址对不对、链接 404）。
 * - **拿不准的只告警**（超时、网络不通 → `⚠️` 而不是 `✗`）。否则脚本会因为"今天网不好"
 *   变红，而红久了的脚本等于没有 —— 这是"体检"和"噪声"的分界线。
 *
 * 退出码：有 `✗` 就是 1（能直接进 CI / cron），只有 `⚠️` 是 0。
 */
import { execFileSync } from 'node:child_process';
import {
  bodyText,
  canonical as readCanonical,
  displayWidth,
  footerLinks,
  jsonLdGraph,
  meta as readMeta,
  sectionText,
  title as readTitle,
} from './lib/html-audit.mjs';

const BASE = (process.env.CONSOLE_URL || 'https://ice-render.github.io/ice-agent-console/').replace(
  /\/?$/,
  '/'
);
/** 只有**外站**（github）探活走代理；打自己的站点直连。 */
const PROXY = process.env.ICE_HTTPS_PROXY || 'http://127.0.0.1:7890';
const GOOGLEBOT =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const SKIP_LINKS = process.argv.includes('--no-links');
/** 站点本身也走代理（`--proxy`）：国内直连 github.io 抖得厉害，见文件头。 */
const PROXY_ALL = process.argv.includes('--proxy');
/** 超时给到 45s：直连时**一次 TCP 握手**就见过 15s+，25s 会误伤。 */
const TIMEOUT = '45';
/** 站点请求统一从这里走 —— 该不该带代理只在这一个地方判。 */
const site = (url, opts = {}) => get(url, { proxy: PROXY_ALL ? PROXY : '', ...opts });
/** 站点响应头同样尊重 `--proxy`（`head` 没法复用 `site()`：那是 GET 那条路）。 */
const siteHead = (url) => head(url, { proxy: PROXY_ALL ? PROXY : '' });

const C = { ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', dim: '\x1b[2m', reset: '\x1b[0m' };
const results = [];
/** 每一条**当场打出来**（体检的价值在于读它，攒到最后再打就没人看了），
 *  同时记进 `results` 供最后的结论统计。 */
const record = (level, label, detail = '') => {
  const mark = level === 'ok' ? '✓' : level === 'warn' ? '!' : '✗';
  console.log(
    `      ${C[level]}${mark}${C.reset} ${label}${detail ? ` ${C.dim}${detail}${C.reset}` : ''}`
  );
  results.push({ level, label, detail });
};
const ok = (label, detail = '') => record('ok', label, detail);
const warn = (label, detail = '') => record('warn', label, detail);
const fail = (label, detail = '') => record('fail', label, detail);

let stepNo = 0;
const step = (msg) => console.log(`\n\x1b[36m[${++stepNo}]\x1b[0m ${msg}`);

/**
 * 一次 GET，返回 `{ status, body }`（连不上时 `status = 0`）。
 *
 * 为什么用 `curl` 而不是 `fetch`：**外站探活要走代理**，而 Node 的 `fetch` 不读
 * `http_proxy` / `https_proxy`（要自己塞 undici 的 dispatcher，那是个依赖）。
 * curl 一行 `-x` 就够，而且它本来就在每台开发的机器上。
 */
function get(url, { ua = '', proxy = '' } = {}) {
  const args = ['-s', '-L', '-m', TIMEOUT, '-w', '\n%{http_code}'];
  if (ua) args.push('-A', ua);
  if (proxy) args.push('-x', proxy);
  args.push(url);
  try {
    const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const cut = out.lastIndexOf('\n');
    return { status: Number(out.slice(cut + 1).trim()) || 0, body: out.slice(0, cut) };
  } catch (e) {
    return { status: 0, body: '', error: String(e.message || e) };
  }
}

/**
 * 响应头 + 状态码（`curl -I`）。
 *
 * ⚠️ **别写成 `-X HEAD`**：curl 会把 HEAD 当"自定义方法"，然后**一直等一个永远不会
 * 到来的响应体**，25 秒后超时失败。第一版就是这么写的，症状是"所有读响应头的检查
 * 全部静默变瞎"（`X-Robots-Tag` 那条假装通过、og:image 那条报 HTTP 0）——
 * 一个永远为空的响应头正是最该被抓住的那种假绿。`-I` 才是 curl 的 HEAD。
 */
function head(url, { proxy = '' } = {}) {
  const args = ['-s', '-L', '-I', '-m', TIMEOUT];
  if (proxy) args.push('-x', proxy);
  args.push(url);
  try {
    return execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  } catch {
    return '';
  }
}

/** 只取状态码（HEAD，跟随时重定向）。 */
function headStatus(url, { proxy = '' } = {}) {
  const args = ['-s', '-L', '-I', '-o', '/dev/null', '-m', TIMEOUT, '-w', '%{http_code}'];
  if (proxy) args.push('-x', proxy);
  args.push(url);
  try {
    return Number(execFileSync('curl', args, { encoding: 'utf8' }).trim()) || 0;
  } catch {
    return 0;
  }
}

console.log(`\n${C.dim}线上体检：${BASE}${C.reset}`);
if (process.env.CONSOLE_URL) {
  /**
   * 打本地产物时**必须说清楚哪几条不是本地的东西**，否则会误读成"本地 robots.txt 没问题"：
   * `robots.txt` / `sitemap.xml` 是按**页面里的 canonical**（= 线上站点）取的 ——
   * 那才是爬虫真正会去的地方。实测过：本地删掉 robots.txt，这一条照样绿。
   */
  console.log(
    `${C.dim}（CONSOLE_URL 覆盖生效：HTML/TDK/正文取自这个地址；` +
      `robots.txt 与 sitemap.xml 仍按 canonical 去取 —— 那是爬虫真正会去的地方）${C.reset}`
  );
}

// ---------------------------------------------------------------- 1. 可达性与响应头
step('可达性与响应头');
const homeBot = site(BASE, { ua: GOOGLEBOT });
if (homeBot.status !== 200) {
  /**
   * 站点都拿不到时**立刻停**：后面每一条检查都会跟着红一片（而它们红的原因是同一个），
   * 读的人会以为"改坏了一大堆东西"。这里只留一句可执行的话 + 一个非零退出码。
   */
  fail('首页可达', `HTTP ${homeBot.status || '连不上'}（本机网络抖动？加 --proxy 再跑一次）`, );
  if (homeBot.error) console.log(`      ${C.dim}${String(homeBot.error).split('\n')[0]}${C.reset}`);
  console.log(
    `\n${C.fail}体检中止：站点取不到，后面的检查做不了。${C.reset}\n` +
      `${C.dim}重试：npm run seo:check -- --proxy（走 ICE_HTTPS_PROXY，实测比直连快 20 倍以上）${C.reset}`
  );
  process.exit(1);
}
ok('首页可达', `HTTP 200 · ${homeBot.body.length} 字节给 Googlebot`);
const homeHeaders = siteHead(BASE);
if (!homeHeaders.trim()) {
  // ⚠️ 取不到响应头 ≠ 没有 X-Robots-Tag。这一条曾经是**假绿**：
  // 空字符串匹配不到 x-robots-tag，于是"没有阻断"被打了勾。
  warn('响应头', '取不到（网络抖动）—— 这条没验成，别当成通过');
} else if (/^x-robots-tag:\s*(.*)$/im.test(homeHeaders)) {
  const v = homeHeaders.match(/^x-robots-tag:\s*(.*)$/im)[1];
  /noindex|none/i.test(v)
    ? fail('响应头没有阻断收录', `X-Robots-Tag: ${v}`)
    : warn('响应头有 X-Robots-Tag', `值=${v}（确认不是 noindex）`);
} else {
  ok('响应头没有阻断收录', '没有 X-Robots-Tag');
}

// ---------------------------------------------------------------- 2. TDK
step('TDK（标题 / 摘要 / 关键词）');
const html = homeBot.body;
const title = readTitle(html);
const description = readMeta(html, 'name', 'description');
const keywords = (readMeta(html, 'name', 'keywords') || '').split(',').map((k) => k.trim()).filter(Boolean);
const robotsMeta = readMeta(html, 'name', 'robots') || '';

!title
  ? fail('title 存在')
  : displayWidth(title) > 70
    ? fail('title 没超显示上限', `${title.length} 字 / 显示宽 ${displayWidth(title)}`)
    : ok('title', `${title.length} 字 / 显示宽 ${displayWidth(title)}：${title}`);

if (!description) fail('description 存在');
else if (description.length < 40) fail('description 够长', `只有 ${description.length} 字`);
else if (displayWidth(description) > 160)
  fail('description 没超显示上限', `显示宽 ${displayWidth(description)}（后半句会被截断）`);
else ok('description', `${description.length} 字 / 显示宽 ${displayWidth(description)}`);

keywords.length >= 5
  ? ok('keywords', `${keywords.length} 词`)
  : fail('keywords 至少 5 个词', `只有 ${keywords.length} 个`);

/noindex/i.test(robotsMeta)
  ? fail('meta robots 允许收录', `robots=${robotsMeta}`)
  : ok('meta robots 允许收录', robotsMeta || '(没写 robots meta，默认允许)');

// ---------------------------------------------------------------- 3. 地址一致性
step('站点地址：canonical / og:url / sitemap / robots 必须是同一个');
const canonical = readCanonical(html);
if (!canonical || !/^https:\/\/[^/]+\/.+/.test(canonical)) {
  fail('canonical 是绝对地址', String(canonical));
} else {
  ok('canonical', canonical);
}
const ogUrl = readMeta(html, 'property', 'og:url');
ogUrl === canonical ? ok('og:url 与 canonical 一致') : fail('og:url 与 canonical 一致', String(ogUrl));

// canonical 缺失时**不能往下走**：第一版直接拿它拼 URL，脚本崩在 TypeError 上，
// 而崩溃的体检脚本给出的信息量为零（首页那一次网络抖动就撞上了）。
const origin = canonical ? canonical.replace(/\/$/, '') : '';
const robotsTxt = origin ? site(`${origin}/robots.txt`) : { status: 0, body: '' };
const sitemapUrl = `${origin}/sitemap.xml`;
if (!origin) {
  warn('/robots.txt 与 /sitemap.xml', 'canonical 缺失，不知道站点根在哪，跳过这两条');
} else if (robotsTxt.status !== 200) {
  fail('/robots.txt 可达', `HTTP ${robotsTxt.status}`);
} else if (!robotsTxt.body.includes(`Sitemap: ${sitemapUrl}`)) {
  fail('/robots.txt 里的 Sitemap 指向本站', `期望 Sitemap: ${sitemapUrl}`);
} else {
  ok('/robots.txt', `→ ${sitemapUrl}`);
}

const sitemap = origin ? site(sitemapUrl) : { status: 0, body: '' };
if (!origin) {
  // 上面那条告警已经说清楚了，这里不重复报
} else if (sitemap.status !== 200) {
  fail('/sitemap.xml 可达', `HTTP ${sitemap.status}`);
} else if (!sitemap.body.includes(`<loc>${canonical}</loc>`)) {
  fail('/sitemap.xml 里的 loc 是本站', `期望 <loc>${canonical}</loc>`);
} else if (!/xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/.test(sitemap.body)) {
  fail('/sitemap.xml 是合法 sitemap', '根节点缺 sitemap 命名空间');
} else {
  ok('/sitemap.xml', `${(sitemap.body.match(/<loc>/g) || []).length} 个 URL`);
}

// ---------------------------------------------------------------- 4. 结构化数据
step('结构化数据（JSON-LD）');
try {
  const types = jsonLdGraph(html).map((n) => n['@type']);
  const want = ['WebSite', 'SoftwareApplication'].filter((t) => !types.includes(t));
  want.length ? fail('JSON-LD 里有 WebSite + SoftwareApplication', `缺 ${want.join(' / ')}`) : ok('JSON-LD', types.join(' + '));
} catch (e) {
  fail('JSON-LD 能读出来', e.message);
}

// ---------------------------------------------------------------- 5. canvas 的文字替身
step('canvas 的文字替身（爬虫读到的正文）');
const summary = sectionText(html, 'site-summary');
summary.length >= 600
  ? ok('#site-summary 有正文', `${summary.length} 字符`)
  : fail('#site-summary 有正文', `只有 ${summary.length} 字符（期望 ≥600）`);
const readable = bodyText(html).length;
// 改之前这个数字是 199（整页只有右面板那几行可见文案）；现在应当 > 1200。
// 它是"文字替身还在不在"的**总量判据** —— 单看某个词会被改写骗过去，总量掉一半骗不过去。
readable >= 1200
  ? ok('不跑 JS 能读到的正文总量', `${readable} 字符`)
  : fail('不跑 JS 能读到的正文总量', `${readable} 字符（改之前是 199，现在应当 >1200）`);
/<noscript[\s>]/i.test(html)
  ? ok('<noscript> 兜底存在')
  : warn('<noscript> 兜底存在', '不执行 JS 的爬虫会看到白屏');

// ---------------------------------------------------------------- 6. 出站链接
step('出站链接（面板底部的家族仓库）');
const links = footerLinks(html).filter((l) => l.href);
if (links.length < 5) {
  fail('家族链接有 5 个以上', `只有 ${links.length} 个`);
} else if (!links.every((l) => /^https:\/\/github\.com\/ice-render\//.test(l.href))) {
  fail('家族链接都指向 ICE 家族仓库', links.map((l) => l.href).join(' '));
} else if (!links.every((l) => /target=["']?_blank/.test(l.tag) && /rel=["']?noopener/.test(l.tag))) {
  warn('家族链接都带 target=_blank + rel=noopener', '有链接缺安全属性');
} else {
  ok('家族链接', `${links.length} 个 · 都是绝对 https + 新窗口`);
}

if (SKIP_LINKS) {
  warn('外站链接探活', '被 --no-links 跳过');
} else {
  const dead = [];
  const unknown = [];
  for (const { href } of links) {
    const r = get(href, { proxy: PROXY });
    if (r.status === 404) dead.push(href);
    else if (r.status === 0) unknown.push(href);
  }
  dead.length
    ? fail('外站链接都能打开', `404：${dead.join(' ')}`)
    : unknown.length
      ? warn('外站链接都能打开', `${unknown.length} 个没探通（网络 / 代理问题，不是 404）`)
      : ok('外站链接都能打开', `${links.length} 个全 200`);
}

// ---------------------------------------------------------------- 7. 分享卡片封面
step('分享卡片（og:image）');
const ogImage = readMeta(html, 'property', 'og:image');
if (!ogImage || !/^https:\/\//.test(ogImage)) {
  fail('og:image 是绝对地址', String(ogImage));
} else {
  const status = headStatus(ogImage, { proxy: PROXY_ALL ? PROXY : '' });
  const type = (siteHead(ogImage).match(/^content-type:\s*(.*)$/im) || [])[1] || '';
  status === 200 && /^image\//i.test(type)
    ? ok('og:image 可访问且是图片', `${ogImage.split('/').pop()} · ${type.trim()}`)
    : fail('og:image 可访问且是图片', `HTTP ${status} · ${type.trim() || '(没有 content-type)'}`);
  const w = readMeta(html, 'property', 'og:image:width');
  const h = readMeta(html, 'property', 'og:image:height');
  w === '1200' && h === '630'
    ? ok('og:image 声明了 1200×630')
    : warn('og:image 声明了 1200×630', `现在是 ${w}×${h}（不是标准社交尺寸）`);
}

// ---------------------------------------------------------------- 8. 有没有按 UA 分流
step('没有做"爬虫特供页"（cloaking）');
{
  const plain = site(BASE);
  plain.status !== 200
    ? warn('普通 UA 也能拿到页面', `HTTP ${plain.status}`)
    : plain.body === homeBot.body
      ? ok('Googlebot 与普通 UA 拿到同一份 HTML', `${homeBot.body.length} 字节，逐字节一致`)
      : fail(
          'Googlebot 与普通 UA 拿到同一份 HTML',
          `长度 ${homeBot.body.length} vs ${plain.body.length} —— 按 UA 分流就是 cloaking，会被罚`
        );
}

// ---------------------------------------------------------------- 结论
console.log('\n' + '─'.repeat(72));
const count = (lv) => results.filter((r) => r.level === lv).length;
const failed = results.filter((r) => r.level === 'fail');
if (failed.length) {
  console.log(`${C.fail}体检不通过：${count('ok')} 项通过 · ${count('warn')} 项告警 · ${failed.length} 项失败${C.reset}`);
  for (const f of failed) console.log(`      ${C.fail}✗${C.reset} ${f.label} ${C.dim}${f.detail}${C.reset}`);
  console.log(`\n${C.dim}提示：离线本地产物体检可以 CONSOLE_URL=http://127.0.0.1:8100/ npm run seo:check${C.reset}`);
  process.exit(1);
}
console.log(
  `${C.ok}体检通过：${count('ok')} 项通过${C.reset}` +
    (count('warn') ? ` · ${C.warn}${count('warn')} 项告警${C.reset}` : '') +
    `\n${C.dim}注意：这里只回答"我们能不能被爬"。收录、排名、点击在 Google Search Console / 百度搜索资源平台，见 README §12.5。${C.reset}`
);
