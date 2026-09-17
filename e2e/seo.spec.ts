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

/**
 * 面板底部那排家族链接。
 *
 * 它同时是**可见 UI** 与**爬虫的出站路径**，所以两边都要钉：
 * 链接得是真 `<a href>`（爬得到）、得在面板里（点它不会打到画布）、
 * 而且加了这一行之后**输入区不能被挤走** —— footer 是 `flex:none`，
 * 它多高就从消息区借多高，借过头的话输入框会被推出面板。
 */
test('面板底部的家族链接：可爬、可点、且没有挤坏输入区', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?autoplay=0');
  await waitDiagramReady(page);

  const links = page.locator('#chat .family a');
  const count = await links.count();
  expect(count, '家族链接应当有 5 个以上').toBeGreaterThanOrEqual(5);

  // ---- 1. 绝对地址、指向真实存在过的仓库、没有重复 ----
  const hrefs = await links.evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).href));
  for (const href of hrefs) expect(href).toMatch(/^https:\/\/github\.com\/ice-render\/[\w-]+$/);
  expect(new Set(hrefs).size).toBe(hrefs.length);

  // ---- 2. 可见（不是藏在 sr-only 里的链接）----
  await expect(links.first()).toBeVisible();

  // ---- 3. 输入区与发送按钮仍然在面板矩形里 ----
  const panel = (await page.locator('#chat').boundingBox())!;
  const input = (await page.locator('#input').boundingBox())!;
  const send = (await page.locator('#send').boundingBox())!;
  expect(input.y + input.height).toBeLessThanOrEqual(panel.y + panel.height);
  expect(send.y + send.height).toBeLessThanOrEqual(panel.y + panel.height);

  // ---- 4. 在链接那一行上滚轮：背后的工艺图不能被缩放 ----
  // （面板整体装了屏蔽，见 src/view/chat.ts 的 shieldFromCanvas。这一条是它的回归线：
  //   哪天有人把屏蔽挪回消息区，这一行就会红。）
  const scale = () => page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport().scale);
  const before = await scale();
  const linkBox = (await links.first().boundingBox())!;
  await page.mouse.move(linkBox.x + linkBox.width / 2, linkBox.y + linkBox.height / 2);
  await page.mouse.wheel(0, -800);
  await page.waitForTimeout(250);
  expect(await scale(), '在链接行上滚轮不该缩放工艺图').toBe(before);

  expect(errors).toEqual([]);
});

/**
 * GA4 那条标签**在本地不许发请求**。
 *
 * 这是刻意加的门控（`public/index.html` 里那段注释写了两个理由），而它有个副作用：
 * 门控一旦被改掉 / 写错，问题**不会有任何可见症状** —— 页面照常工作，
 * 只是本地开发与每一轮 e2e 都开始往 GA 灌流量。
 *
 * ⚠️ 更硬的一条是**实测出来的**：GA 在工作正常的情况下，自己那些重复 beacon
 * 也会被 Chromium 记成 `requestfailed: net::ERR_ABORTED`（在非本地主机上验过：
 * `gtag/js` 200、`g/collect` 204、另两条 collect 是 ERR_ABORTED）。
 * 而 `collectErrors` 把 `requestfailed` 当错误、每条用例都断言它为空 ——
 * 所以门控一旦失效，**整个 e2e 套件会自己红**，跟网络好坏无关。
 *
 * 所以这里钉两件事：**标签确实在**（测量 ID 在 HTML 里）、**本地确实一个请求都不发**。
 * 少了前一半，把标签整个删掉也能让后一半通过。
 */
test('GA4：标签在产物里，但本地一个请求都不发', async ({ page }) => {
  const gaHits: string[] = [];
  page.on('request', (r) => {
    if (/googletagmanager\.com|google-analytics\.com/.test(r.url())) gaHits.push(r.url());
  });

  const errors = collectErrors(page);
  await page.goto('/?autoplay=0');
  await waitDiagramReady(page);
  // 给它足够的时间去"本来应该"发请求（gtag 是 async 注入的）
  await page.waitForTimeout(1000);

  // 前一半：标签真的在产物里（测量 ID 从 HTML 里读得到）
  const html = await page.content();
  expect(html, 'GA 的测量 ID 应当在页面里').toContain('G-HW6H6EP0ES');

  // 后一半：localhost 上不该有任何 GA 请求
  expect(gaHits, '本地产物不该往 GA 发请求（会灌假流量，且让用例依赖 Google 的网络）').toEqual(
    []
  );
  expect(await page.evaluate(() => typeof (window as any).gtag)).toBe('undefined');

  expect(errors).toEqual([]);
});
