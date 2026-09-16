/**
 * TDK 与"画布的文字替身"—— e2e 这一半。
 *
 * 单测（`tests/seo.test.ts`）读的是 `public/` 源码；这里跑的是 **`dist/` 的产物**，
 * 两点不一样，而且都会真出问题：
 *
 *   1. `html-webpack-plugin` 在 production 下会把 HTML **压缩一遍**。
 *      "压缩会不会吃掉某个标签 / 把 JSON-LD 弄成非法 JSON"只有对着产物看才知道。
 *   2. 加了隐藏文本之后**布局有没有被顶坏**，只能真开一次浏览器看。
 *      这个页面的布局是"绘图区铺满视口 + 对话面板浮在右边缘"，
 *      任何多出来的可见元素都会把画布挤歪或者顶出滚动条。
 *
 * ⚠️ 这一组用例的失败**都没有任何"功能"症状**：页面照样能用，只是搜不到、
 * 分享出去卡片空白。所以判据必须写在测试里，别指望人工发现。
 */
import { expect, test } from '@playwright/test';
import { DIAGRAM_CANVAS, collectErrors, waitDiagramReady } from './helpers';

test('head 里的 TDK / OG / JSON-LD 在产物里完好（压缩没吃掉它们）', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?autoplay=0');

  // title 与 description：搜索结果里那两行就是它们
  await expect(page).toHaveTitle(/ICE Agent Console/);
  const description = await page.locator('meta[name="description"]').getAttribute('content');
  expect(description).toContain('AG-UI');

  // 用"浏览器真的解析出来的值"判，而不是再正则扫一遍源码
  expect(await page.locator('meta[name="keywords"]').getAttribute('content')).toContain('AG-UI');
  const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
  expect(canonical).toBe('https://ice-render.github.io/ice-agent-console/');
  expect(await page.locator('meta[property="og:url"]').getAttribute('content')).toBe(canonical);

  // JSON-LD：**在浏览器里 parse 一遍** —— 压缩器把结构化数据弄坏时这里是唯一的探针
  const raw = await page.locator('script[type="application/ld+json"]').textContent();
  const graph = (JSON.parse(raw as string) as any)['@graph'];
  expect(graph.map((n: any) => n['@type'])).toEqual(
    expect.arrayContaining(['WebSite', 'SoftwareApplication'])
  );

  expect(errors).toEqual([]);
});

test('文字替身藏得干净：不占位、不挡画布、不顶出滚动条', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?autoplay=0');
  await waitDiagramReady(page);

  // ---- 1. 它在 DOM 里、有正文，但视觉上只是个 1×1 的角 ----
  const summary = page.locator('#site-summary');
  await expect(summary).toHaveCount(1);
  const box = (await summary.boundingBox())!;
  expect(box.width, '文字替身不能占版面').toBeLessThanOrEqual(2);
  expect(box.height).toBeLessThanOrEqual(2);
  const style = await summary.evaluate((el) => {
    const s = getComputedStyle(el);
    return { clipPath: s.clipPath, display: s.display, visibility: s.visibility };
  });
  // ⚠️ 判据是"藏起来"而不是"删掉"：display:none 会连无障碍树与部分爬虫一起跳过
  expect(style.display).not.toBe('none');
  expect(style.visibility).not.toBe('hidden');
  expect(style.clipPath).not.toBe('none');

  // ---- 2. 画布**仍然是铺满视口的那一块**（这一条才是这个用例存在的理由）----
  const canvas = (await page.locator(DIAGRAM_CANVAS).boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(canvas.width).toBe(viewport.width);
  expect(canvas.height).toBe(viewport.height);

  // ---- 3. 页面本身不滚（多出来的隐藏元素把 body 顶高了就会滚）----
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - window.innerWidth,
    y: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(overflow.x).toBeLessThanOrEqual(0);
  expect(overflow.y).toBeLessThanOrEqual(0);

  // ---- 4. 它不在鼠标的命中路径上（1px 的隐形块压在画布角上也是坑）----
  const hit = await page.evaluate(() => {
    const el = document.elementFromPoint(1, 1);
    return !!el?.closest('#site-summary');
  });
  expect(hit).toBe(false);

  expect(errors).toEqual([]);
});

test('键盘 Tab 到文字替身里的链接时，它是**看得见**的', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?autoplay=0');
  await waitDiagramReady(page);

  // 文字替身里的链接是可聚焦的（屏幕阅读器用户要靠它跳去源码）。
  // 代价是"键盘用户会聚焦到一个看不见的东西"—— 所以聚焦时必须真的显示出来。
  const link = page.locator('#site-summary a').first();
  const positionOf = () => link.evaluate((el) => getComputedStyle(el).position);

  await link.focus();
  // 判据用 computed style，不用 boundingBox 的宽度：
  // 那一条 inline 链接的**布局盒**本来就有 266px 宽（由文字撑开），
  // 而 `.sr-only` 是在**父级**上剪的 —— 量子元素宽度看不出它有没有被藏起来（踩过）。
  expect(await positionOf(), '聚焦时那条规则要把它变成固定定位的可见按钮').toBe('fixed');
  const focusBox = (await link.boundingBox())!;
  expect(focusBox.width, '聚焦后应当是一块看得见的按钮').toBeGreaterThan(40);
  expect(focusBox.height).toBeGreaterThan(20);
  // 而且要**在视口里**（fixed 到屏幕外和没显示是同一种坏）
  expect(focusBox.y).toBeGreaterThanOrEqual(0);
  expect(focusBox.y + focusBox.height).toBeLessThanOrEqual(page.viewportSize()!.height);

  // 失焦之后回到"藏起来"的状态（别在画布上永久留一块）
  await link.blur();
  expect(await positionOf()).not.toBe('fixed');

  expect(errors).toEqual([]);
});
