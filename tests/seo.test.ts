/**
 * TDK / 爬虫可见性。
 *
 * 这一页几乎全是 canvas：工艺图、图表、控件条都画在画布上，**DOM 里没有正文**
 * （`<canvas>` 对爬虫是个空壳）。所以"这个页面能不能被搜到、搜到时长什么样"
 * 完全落在三处静态文件上：
 *
 *   1. `public/index.html` 的 head —— title / description / keywords / canonical / OG / JSON-LD；
 *   2. `public/index.html` 末尾的 `#site-summary` —— 画布内容的**文字替身**；
 *   3. `public/robots.txt` + `public/sitemap.xml` —— 站点根目录的爬虫入口。
 *
 * ## 为什么值得单测
 *
 * 因为这一整套东西**坏掉的时候页面完全正常**：没有任何"用户"会用到它，只有爬虫会用，
 * 而爬虫不会报错。少一个 `og:image` 指向的文件、canonical 写成 `/`、keywords 被删空
 * —— 三条都没有任何可观察的症状。
 *
 * 判据分两类：
 *   · **在不在**：标签、文件、文字替身有没有；
 *   · **是不是同一个站点地址**：canonical / og:url / sitemap 的 `<loc>` / robots 的
 *     `Sitemap:` 四处必须指向同一个 origin + path（对不上时搜索引擎看到的是两个站点）。
 *
 * 文案本身**不钉死**（改文案是常事），只钉长度上下限、必须出现的关键词，
 * 以及"文案里报的数字必须跟内置案例对得上"（见最后一组）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WATER_PROCESS_DSL } from '../shared/water-process-case';

const ROOT = resolve(__dirname, '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const html = read('public/index.html');
const robots = read('public/robots.txt');
const sitemap = read('public/sitemap.xml');

/** 把一段标签属性文本里的属性取出来（产物里引号可能被省掉，这里只测源码，仍然宽松取）。 */
const attr = (raw: string, key: string): string | null => {
  const m = raw.match(new RegExp(`(?:^|\\s)${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'));
  return m ? m[1] ?? m[2] ?? m[3] ?? null : null;
};
const metas = [...html.matchAll(/<meta\s[^>]*>/gi)].map((m) => m[0]);
const meta = (kind: string, key: string): string | null => {
  const hit = metas.find((t) => (attr(t, kind) || '').toLowerCase() === key.toLowerCase());
  return hit ? attr(hit, 'content') : null;
};
const tagText = (s: string): string => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

/**
 * **展示宽度**（一个全角字按 2 算）。
 *
 * 为什么不能只数字符数：搜索结果的标题 / 摘要按**像素宽度**截断，而中文一个字
 * 顶两个西文字符。写 description 时踩过一次 —— 158 个字符看着"没超 160"，
 * 换算下来约 316 个半角宽，是 Google 上限（约 155）的两倍，**后半句根本露不出来**：
 * 多写的那半句不是"信息量更大"，是"白写"。标题同理。
 *
 * 这个换算只是近似（真正的上限还跟字体、字符种类有关），但足够拦住数量级错误。
 */
const displayWidth = (s: string): number =>
  [...s].reduce((n, ch) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1), 0);

const title = (html.match(/<title>([^<]+)<\/title>/) || [])[1] || '';
const description = meta('name', 'description') || '';
const keywords = (meta('name', 'keywords') || '').split(',').map((k) => k.trim()).filter(Boolean);
const canonicalTag = html.match(/<link[^>]*rel=["']?canonical["']?[^>]*>/i);
const canonical = (canonicalTag && attr(canonicalTag[0], 'href')) || '';
const summaryTag = html.match(/<section[^>]*id=["']?site-summary["']?[\s\S]*?<\/section>/i);
const summary = summaryTag ? summaryTag[0] : '';
const summaryText = tagText(summary);

describe('TDK（title / description / keywords）', () => {
  it('title 有且只有一个，长度落在搜索结果不截断的区间里', () => {
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(title).toContain('ICE Agent Console');
    // 太长会被截断、太短等于没写
    expect(title.length).toBeGreaterThanOrEqual(10);
    expect(title.length).toBeLessThanOrEqual(60);
    // 按显示宽度算（jest 的 expect 不吃说明文案，所以理由写在断言上面）
    expect(displayWidth(title)).toBeLessThanOrEqual(70);
  });

  it('description 是给搜索结果用的那段摘要，长度合适且点到了核心', () => {
    expect(description.length).toBeGreaterThanOrEqual(40);
    expect(description.length).toBeLessThanOrEqual(160);
    // 见 displayWidth 的注释：中英混排时**只有按显示宽度量**才知道会不会被截掉
    expect(displayWidth(description)).toBeLessThanOrEqual(160);
    expect(description).toContain('AG-UI');
    expect(description).toContain('Canvas');
  });

  it('keywords 有词，且不是只写了个品牌名', () => {
    // Google 早就不看 keywords，百度 / 360 / 搜狗看 —— 所以留着，但不能是垃圾
    expect(keywords.length).toBeGreaterThanOrEqual(8);
    expect(keywords).toContain('AG-UI');
    expect(keywords.every((k) => k.length > 0)).toBe(true);
    // 同一个词写两遍是典型的"为关键词而写"
    expect(new Set(keywords).size).toBe(keywords.length);
  });

  it('允许收录，且声明了语言', () => {
    expect(meta('name', 'robots') || '').toContain('index');
    expect(meta('name', 'robots') || '').not.toContain('noindex');
    expect(html).toMatch(/<html lang="zh-CN">/);
  });
});

describe('canonical / OG / 站点地址：四处必须是同一个', () => {
  it('canonical 是绝对地址（子路径部署时写 "/" 会指向另一个站点）', () => {
    expect(canonical).toMatch(/^https:\/\/[^/]+\/.+\/$/);
  });

  it('og:url 与 canonical 一致 —— 不一致会被当成两个页面', () => {
    expect(meta('property', 'og:url')).toBe(canonical);
  });

  it('OG / Twitter 卡片齐全（分享出去得有个像样的样子）', () => {
    expect(meta('property', 'og:type')).toBe('website');
    expect(meta('property', 'og:title')).toBe(title);
    expect(meta('property', 'og:description')).toBeTruthy();
    expect(meta('property', 'og:image')).toBeTruthy();
    expect(meta('name', 'twitter:card')).toBe('summary_large_image');
    expect(meta('name', 'twitter:image')).toBe(meta('property', 'og:image'));
  });

  it('og:image 指向 public/ 里真实的文件（指向空气 = 卡片空白，且不报错）', () => {
    const image = meta('property', 'og:image') || '';
    expect(image.startsWith(canonical)).toBe(true);
    expect(existsSync(join(ROOT, 'public', image.split('/').pop() as string))).toBe(true);
    // 1200×630：社交卡片的标准尺寸（太小的图在很多平台上不会展开成大图）
    expect(meta('property', 'og:image:width')).toBe('1200');
    expect(meta('property', 'og:image:height')).toBe('630');
  });

  it('robots.txt 的 Sitemap 与 sitemap.xml 的 loc 都指向 canonical', () => {
    expect(robots).toContain(`Sitemap: ${canonical}sitemap.xml`);
    expect(sitemap).toContain(`<loc>${canonical}</loc>`);
  });

  it('robots.txt 不封自己（整站就一个页面，封一个等于全封）', () => {
    expect(robots).toMatch(/User-agent: \*/);
    expect(robots).toMatch(/Allow: \/[\s]*$/m);
    expect(robots).not.toMatch(/^Disallow: \/$/m);
  });
});

describe('结构化数据（JSON-LD）', () => {
  const raw = (html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1] || '';
  // 解析失败就等于"写了但搜索引擎读不到" —— 所以测试里第一件事就是真的 parse 一遍
  const parsed = JSON.parse(raw) as { '@graph': Array<Record<string, unknown>> };
  const byType = (t: string) => parsed['@graph'].find((n) => n['@type'] === t) as Record<string, any>;

  it('@graph 里同时有 WebSite 与 SoftwareApplication', () => {
    expect(parsed['@graph'].map((n) => n['@type'])).toEqual(
      expect.arrayContaining(['WebSite', 'SoftwareApplication'])
    );
  });

  it('SoftwareApplication 的 url 与截图地址都对得上', () => {
    const app = byType('SoftwareApplication');
    expect(app.url).toBe(canonical);
    expect(app.screenshot).toBe(meta('property', 'og:image'));
    expect(app.applicationCategory).toBeTruthy();
    expect(app.isAccessibleForFree).toBe(true);
    expect(app.featureList.length).toBeGreaterThanOrEqual(5);
  });

  it('WebSite 声明了语言', () => {
    expect(byType('WebSite').inLanguage).toBe('zh-CN');
  });
});

describe('canvas 的文字替身（爬虫能读到的正文）', () => {
  it('#site-summary 存在、有内容，而且**真的被藏起来了**', () => {
    expect(summary).toBeTruthy();
    expect(summary).toMatch(/class="sr-only"/);
    // 换成 display:none / visibility:hidden 会连无障碍树一起藏掉，等于白写
    expect(html).toMatch(/\.sr-only\s*\{[^}]*clip-path/);
  });

  it('正文长度够（爬虫得有东西可读），且覆盖了画布上的三类图层', () => {
    expect(summaryText.length).toBeGreaterThanOrEqual(600);
    for (const word of ['工艺图', '图表', '表单', 'AG-UI', 'Canvas']) {
      expect(summaryText).toContain(word);
    }
  });

  it('把主流程讲了一遍（这是这一页真正的"内容"）', () => {
    for (const stage of ['粗格栅', '初沉池', '厌氧池', '缺氧池', '好氧池', '二沉池']) {
      expect(summaryText).toContain(stage);
    }
  });

  it('文案里报的规模必须与内置案例对得上（数字会过期）', () => {
    // 这两条是"改图之后忘了改文案"的探针：加一个单元，这里立刻红
    expect(summaryText).toContain(`${WATER_PROCESS_DSL.units.length} 个单元`);
    expect(summaryText).toContain(`${WATER_PROCESS_DSL.pipes.length} 段管线`);
  });

  it('不跑 JS 的爬虫（百度 / 360 / 搜狗）看到的是说明，不是白屏', () => {
    const noscript = html.match(/<noscript>([\s\S]*?)<\/noscript>/);
    expect(noscript).toBeTruthy();
    expect(tagText(noscript![1]).length).toBeGreaterThan(40);
  });
});

describe('标题是这一页的身份，不许随画面漂', () => {
  it('运行期没有任何地方改 document.title', () => {
    /**
     * 演示构建开页会自动开演、图层会从工艺图切到图表。抓取时若渲染到那一刻，
     * 被改过的 title 就成了索引结果 —— "标题是什么"取决于播放到第几拍，
     * 而且每次抓取都不一样。所以这条是**硬约束**，不是风格问题。
     */
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(join(ROOT, 'src'));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) => /document\s*\.\s*title/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => f.replace(`${ROOT}/`, ''))).toEqual([]);
  });
});
