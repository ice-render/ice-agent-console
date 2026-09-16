#!/usr/bin/env node
/**
 * 把演示产物发到 GitHub Pages。
 *
 * ## 为什么是一个脚本，而不是 README 里那五行命令
 *
 * 因为这五行里有**四个必须做对、做错了不报错**的地方，全都实测踩过：
 *
 * 1. **必须用 `build:demo` 的产物**，不是 `build` 的。
 *    后者默认连后端（`__ICE_DEMO__` 为 false），推上去开页就白屏找 8099。
 *    脚本会**读产物自证**：产物里 `__ICE_DEMO__` 必须已被替换掉，
 *    而且能搜到"演示模式"那行文案 —— 两个都过了才继续。
 * 2. **`.nojekyll` 不能省**。GitHub Pages 默认拿 Jekyll 处理一遍，
 *    而 Jekyll 会**忽略下划线开头的文件/目录**。当前产物没有这种文件，
 *    但哪天 asset 命名带上 `_`，就会静默少一个文件、页面白屏，而构建日志是绿的。
 * 3. **推送必须是 force**。`gh-pages` 每次装的是一份全新的产物，
 *    历史没有意义（上一版的 `boot.<hash>.js` 留在分支上只会白占体积）。
 * 4. **远端是 `origin-github`，不是 `origin`** —— 本仓 `origin` 指向 gitee，
 *    而 gitee 的 Pages 是另一套（要手动开、且免费版有限制）。两个远端并存是历史原因。
 * 5. **`robots.txt` / `sitemap.xml` / `og-cover.jpg` 必须真的躺在站点根目录**。
 *    它们在 `public/` 里、由 webpack 搬进 `dist/`（见 `CopyPublicFiles`），而这一分支
 *    是**整份 dist/ 拷过来的**。丢掉它们的症状是：页面完全正常，爬虫抓不到、
 *    分享卡片空白 —— 只有对着线上站点 `curl /robots.txt` 才看得出来。
 *    第 2b 步的自检会把这些逐条验一遍（含"og:image 指向的文件真的在产物里"）。
 *
 * ## 用法
 *
 * ```bash
 * npm run deploy:pages            # 构建 + 自检 + 推 origin-github 的 gh-pages
 * npm run deploy:pages -- --dry   # 只构建与自检，停在本地（想看产物有没有问题）
 * ```
 *
 * 推完之后**还要在仓库 Settings → Pages 里确认** Source = "Deploy from a branch" /
 * `gh-pages` / `/(root)`。这一条脚本管不了（要 repo 的 admin 权限），
 * 而且**它是"推上去了但站点一直 404"的头号原因**：Source 若停在 GitHub Actions、
 * 仓库里又没有 workflow，那**一次构建都不会发生**，且没有任何报错。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// 读 TDK / 爬虫字段的那套判据抽在 scripts/lib/ 里 —— 线上体检脚本用的是同一份
// （两份"我抄你一份"的解析会在改判据时静默漂：一个说通过、另一个说失败）。
import {
  canonical as readCanonical,
  displayWidth,
  jsonLdGraph,
  meta as readMeta,
  sectionText,
  title as readTitle,
} from './lib/html-audit.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
/** 临时工作区：产物在这里组装成一个干净的 gh-pages 提交。 */
const WORK = join(ROOT, '.pages-work');
const BRANCH = 'gh-pages';
const REMOTE = 'origin-github';
const DRY = process.argv.includes('--dry');

const step = (n, msg) => console.log(`\n\x1b[36m[${n}/5]\x1b[0m ${msg}`);
const ok = (msg) => console.log(`      \x1b[32m✓\x1b[0m ${msg}`);
const die = (msg) => {
  console.error(`\n\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
};
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });

// ---------------------------------------------------------------- 1. 构建
step(1, '构建演示产物（npm run build:demo）');
sh('npm', ['run', 'build:demo'], { cwd: ROOT });
if (!existsSync(DIST)) die('dist/ 没有生成');

// ---------------------------------------------------------------- 2. 自检产物
step(2, '自检：这份产物真的是演示模式吗');
/**
 * 判据是**产物里那个编译后的默认值**，不是"有没有 `__ICE_DEMO__` 残留"。
 *
 * ⚠️ 第一版判据写成"搜不到 `__ICE_DEMO__` 字样就算过" —— 那是**错的**：
 * `DefinePlugin` 在两种构建里都会把它替换掉（普通构建换成 `false`），
 * 所以"无残留"对普通构建同样成立，等于没检。而"演示模式"那串文案也留在源码里
 * （一行永远不会走到的三元分支），一并失效。实测过：拿普通 `npm run build` 的产物
 * 去喂那条自检，它照样说"通过"。
 *
 * `resolveRunMode(search, buildDefaultDemo = BUILD_DEFAULT_DEMO)` 编译之后，
 * 那个默认参数会变成字面量 `!0`（true）或 `!1`（false）—— **这才是唯一的区别**。
 * 两种构建我都比过：普通 `..=!1`，演示 `..=!0`，各命中一次。
 *
 * 锚点选 `URLSearchParams` 是因为它就是 `resolveRunMode` 体里的第一个语句，
 * 而"带默认值的形参 + new URLSearchParams"这个组合在产物里只有这一处。
 * 找不到匹配时**直接失败**而不是放过 —— 压缩器换了命名风格时，
 * 宁可让部署停下来让人看一眼，也不要静默推一份不知道是什么的东西上去
 * （部署脚本"看着成功了"是最坏的一种失败）。
 */
const RESOLVE_ANCHOR = /=function\([^,)]+,[^,)]+=(!0|!1)\)\{const \w+=new URLSearchParams\(/g;
const bundles = globSync('boot.*.js', { cwd: DIST });
if (bundles.length === 0) die('dist/ 里没有 boot.*.js');
for (const b of bundles) {
  const code = readFileSync(join(DIST, b), 'utf8');
  const hits = [...code.matchAll(RESOLVE_ANCHOR)].map((m) => m[1]);
  if (hits.length !== 1) {
    die(
      `${b} 里"构建期默认模式"这个锚点命中了 ${hits.length} 次（期望 1 次）。\n` +
        '  压缩器的产物形状变了，这条自检已经不可靠 —— 请人工确认之后改锚点（见本文件注释），\n' +
        '  不要直接放行：这一条正是用来防"把连后端的产物推到演示站点上"的。'
    );
  }
  if (hits[0] !== '!0') {
    die(`${b} 的构建期默认是 server（${hits[0]}）—— 这不是演示构建。\n  请用 npm run build:demo（= npm run deploy:pages 的第一步）。`);
  }
  ok(`${b}：构建期默认 = demo（!0）、${(code.length / 1048576).toFixed(2)} MiB`);
}
// 相对路径是子路径部署的前提，顺手也验一下（写成 `/boot.js` 的话站点会 404）
const html = readFileSync(join(DIST, 'index.html'), 'utf8');
if (!/<script[^>]+src=boot\.[a-f0-9]+\.js/.test(html)) die('index.html 里没有相对路径引用的 boot 脚本');
ok('index.html 用的是相对路径（子路径部署的前提）');

// ------------------------------------------------- 2b. 自检 TDK / 爬虫三件套
step('2b', '自检：TDK 与爬虫三件套（它们全是静态文件，只对着产物看才算数）');
/**
 * ## 为什么这条自检必须在**产物**上做
 *
 * title / description / keywords、JSON-LD、robots.txt、sitemap.xml 全都**不是运行时拼的**
 * —— 爬虫读的就是 `dist/index.html` 这份原文（`html-webpack-plugin` 在 production 下
 * 还会把它压缩一遍，而"压缩会不会吃掉某个标签"也只有对着产物看才知道）。
 *
 * 这里**只钉"在不在"与"是不是同一个站点地址"**，不钉文案本身：文案会改，站点地址不会。
 * 文案层面的规矩（关键词、文字替身、不许动态改 title）在 `tests/seo.test.ts`。
 *
 * 最容易坏的一处是 **og:image 指向一个没被部署的文件** —— 页面完全正常、分享卡片空白、
 * 构建与环境都不报错。所以这里把那个 URL 反解成本地文件名，真的去 dist/ 里找一遍。
 */

// title / description / keywords —— TDK 三件套本体
const title = readTitle(html);
if (!title) die('index.html 里没有 <title>');
if (title.length < 10 || displayWidth(title) > 70) {
  die(`title 长 ${title.length} 字 / 显示宽 ${displayWidth(title)}（太长会被搜索结果截断）：「${title}」`);
}
const description = readMeta(html, 'name', 'description');
if (!description || description.length < 40) {
  die(`description 缺失或过短（${description ? description.length : 0} 字符）—— 搜索结果里那两行摘要就是它`);
}
if (displayWidth(description) > 160) {
  die(`description 的显示宽度 ${displayWidth(description)} 超了（中文一个字顶两个西文字符，会被截断）`);
}
const keywords = readMeta(html, 'name', 'keywords');
const words = (keywords || '').split(',').filter((k) => k.trim());
if (words.length < 5) die('keywords 缺失或少于 5 个词（Google 不看，百度 / 360 / 搜狗看）');
if ((readMeta(html, 'name', 'robots') || '').includes('noindex')) die('robots meta 里写着 noindex');
ok(`title ${title.length} 字 / description ${description.length} 字 / keywords ${words.length} 词`);

// canonical：**必须是绝对地址**（子路径部署时写 "/" 会指向域名根，那是另一个站点）
const canonical = readCanonical(html);
if (!canonical || !/^https:\/\/[^/]+\/.+/.test(canonical)) {
  die(`canonical 缺失或不是绝对地址：${canonical}（要写全 https://<域>/<子路径>/）`);
}
if (readMeta(html, 'property', 'og:url') !== canonical) {
  die('og:url 与 canonical 不一致（会被当成两个页面）');
}
ok(`canonical = og:url = ${canonical}`);

// JSON-LD：**必须真的能 JSON.parse**（多一个逗号就是"结构化数据静默失效"）。
// 压缩器一般不动它，多数是手改时多了个逗号 —— 所以这里把原因带进报错里。
let graph;
try {
  graph = jsonLdGraph(html);
} catch (e) {
  die(`JSON-LD 读不出来：${e.message}`);
}
const types = graph.map((n) => n['@type']);
for (const t of ['WebSite', 'SoftwareApplication']) {
  if (!types.includes(t)) die(`JSON-LD 里少了 @type=${t}`);
}
ok(`JSON-LD 合法：${types.join(' + ')}`);

// 文字替身：**canvas 页面的正文就靠它**
const summaryText = sectionText(html, 'site-summary');
if (summaryText.length < 600) die(`#site-summary 只剩 ${summaryText.length} 字符可读文本（期望 ≥600）`);
if (!/<noscript[\s>]/.test(html)) die('index.html 里没有 <noscript> 兜底（不跑 JS 的爬虫看到的是白屏）');
ok(`文字替身 ${summaryText.length} 字符 + noscript 兜底`);

// 站点根目录那两个文件：它们在不在 dist/ 里、loc 对不对
for (const f of ['robots.txt', 'sitemap.xml']) {
  if (!existsSync(join(DIST, f))) die(`dist/${f} 不存在（webpack 的 CopyPublicFiles 没搬过来？）`);
}
const robots = readFileSync(join(DIST, 'robots.txt'), 'utf8');
const sitemapUrl = `${canonical.replace(/\/$/, '')}/sitemap.xml`;
if (!robots.includes(`Sitemap: ${sitemapUrl}`)) die(`robots.txt 里的 Sitemap 不是 ${sitemapUrl}`);
if (!readFileSync(join(DIST, 'sitemap.xml'), 'utf8').includes(`<loc>${canonical}</loc>`)) {
  die(`sitemap.xml 里没有 <loc>${canonical}</loc>`);
}
ok(`robots.txt → ${sitemapUrl}，sitemap.xml → ${canonical}`);

// og:image：卡片封面**必须真的部署上去了**（指向空气是这类标签最常见的坏法）
const ogImage = readMeta(html, 'property', 'og:image');
if (!ogImage) die('没有 og:image');
const ogFile = ogImage.split('/').pop();
if (!ogImage.startsWith(canonical) || !existsSync(join(DIST, ogFile))) {
  die(`og:image 指向 ${ogImage}，但 dist/${ogFile} 不存在 —— 分享卡片会是空白`);
}
ok(`og:image ${ogFile} 在产物里（${(readFileSync(join(DIST, ogFile)).length / 1024).toFixed(0)} KiB）`);

if (DRY) {
  console.log(`\n\x1b[33m--dry：自检通过，停在本地。产物在 ${DIST}\x1b[0m`);
  console.log('想本地看效果：npx http-server dist -p 8200 -c-1');
  process.exit(0);
}

// ---------------------------------------------------------------- 3. 组装分支
step(3, `组装 ${BRANCH} 分支（.pages-work/）`);
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
/**
 * **整份 dist/ 搬过去**，不再逐个文件白名单。
 *
 * 理由：白名单那种写法每加一个静态文件（这次就是 robots.txt / sitemap.xml / og-cover.jpg）
 * 都要回来改一次，而**漏改的后果是静默的** —— 线上 404、构建日志照样是绿的。
 * `output.clean` 保证 dist/ 里没有陈年垃圾，所以 dist/ 就是"要发的东西"的完整定义，
 * 直接递归拷贝，以后加文件不用再动这里。
 */
cpSync(DIST, WORK, { recursive: true });

/**
 * `sitemap.xml` 的 `<lastmod>` 按**最后一次提交的日期**重写。
 *
 * 不用"部署当天"：源码没动就不该假装页面更新过 —— 长期虚报的 lastmod 会被搜索引擎
 * 判成不可信，之后真更新了也不再采信。拿不到 git 日期（比如浅克隆）就保留仓库里那份。
 */
try {
  const stamp = execFileSync('git', ['log', '-1', '--format=%cs'], { cwd: ROOT }).toString().trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(stamp)) {
    const smPath = join(WORK, 'sitemap.xml');
    writeFileSync(
      smPath,
      readFileSync(smPath, 'utf8').replace(/<lastmod>[^<]*<\/lastmod>/, `<lastmod>${stamp}</lastmod>`)
    );
    ok(`sitemap.xml 的 lastmod = ${stamp}（最后一次提交的日期）`);
  }
} catch {
  console.log('      \x1b[33m!\x1b[0m 读不到 git 提交日期，sitemap.xml 沿用仓库里的 lastmod');
}

// 见文件头第 2 条：这一行不能省
writeFileSync(join(WORK, '.nojekyll'), '');
writeFileSync(
  join(WORK, 'README.md'),
  [
    '演示站点 —— 由 `npm run deploy:pages`（= `npm run build:demo` + 推送）生成。',
    '',
    '**不要手工改这个分支**：每次部署都会用 `--force` 覆盖成一整份新产物。',
    '源码与文档在 `main`。',
    '',
    '产物是纯前端：不连任何后端，直接双击 `index.html`（`file://`）也能跑。',
    '',
  ].join('\n')
);
ok(`已放入 dist/ 的全部内容 + .nojekyll + README.md（${bundles.length} 个 JS）`);
ok('没有放进 dist/ 之外的东西（源码、node_modules、docs/images 都不进这个分支）');

// ---------------------------------------------------------------- 4. 提交
step(4, '提交');
const git = (args, opts) => sh('git', args, { cwd: WORK, ...opts });
if (!existsSync(join(WORK, '.git'))) git(['init', '-q', '-b', BRANCH]);
// 身份从主仓借：临时工作区里没有 config
const name = execFileSync('git', ['config', 'user.name'], { cwd: ROOT }).toString().trim();
const email = execFileSync('git', ['config', 'user.email'], { cwd: ROOT }).toString().trim();
git(['add', '-A']);
// `--allow-empty`：产物没变时（只改了源码但没重新构建）也让这次部署成功退出
git(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '--allow-empty', '-m', 'demo site']);
const files = execFileSync('git', ['show', '--stat', '--oneline', 'HEAD'], { cwd: WORK }).toString().trim();
console.log(files.split('\n').map((l) => '      ' + l).join('\n'));

// ---------------------------------------------------------------- 5. 推送
step(5, `推送到 ${REMOTE} 的 ${BRANCH}`);
const proxy = process.env.ICE_HTTPS_PROXY || 'http://127.0.0.1:7890';
console.log(`      走代理 ${proxy}（直连 github 不通；见 AGENTS.md / 记忆里的那条）`);
git(['push', '-f', `https://github.com/ice-render/ice-agent-console.git`, `${BRANCH}:${BRANCH}`], {
  env: { ...process.env, https_proxy: proxy, http_proxy: proxy },
});
rmSync(WORK, { recursive: true, force: true });
console.log('\n\x1b[32m推送完成。\x1b[0m');
console.log('  站点  https://ice-render.github.io/ice-agent-console/');
console.log('  ⚠️ 若站点 404：去 Settings → Pages 确认 Source = "Deploy from a branch" / gh-pages / /(root)。');
console.log('     停在 GitHub Actions 而仓库里又没有 workflow 的话，一次构建都不会发生（且不报错）。');
