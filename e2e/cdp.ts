/**
 * **CDP 夹具**：把用例跑在"已经开着的那只 Chrome"里，而不是 Playwright 自己拉起的无头壳。
 *
 * ## 为什么要这个（而不是 `use: { channel: 'chrome' }`）
 *
 * 默认那条路是 Playwright **自己**启动浏览器：进程是它拉的、窗口默认是无头的，
 * 跑完就没了 —— 人在旁边什么都看不到。CDP 是反过来：浏览器**本来就开着**，
 * Playwright 连上去接管，于是点到哪儿、画到哪儿，旁边的人**当场看得见**。
 *
 * ⚠️ Playwright Test 的 `use.connectOptions` **不是**这条路 —— 那个 `wsEndpoint`
 * 说的是 `npx playwright run-server`（`playwright ... connect` 协议），
 * 不是 Chrome 的 CDP 端口（`/json/version` 里那个 `webSocketDebuggerUrl`）。
 * 想连 CDP 只能覆盖 `browser` 夹具，也就是这个文件。
 *
 * ## 开关只有一个：`ICE_CDP_ENDPOINT`
 *
 * 设了就连它（例：`http://127.0.0.1:9223`），没设就**完全退回默认行为**。
 * 所以 spec 可以统一 `import { test } from './cdp'`，
 * `npm run test:e2e`（无头、自己起浏览器）与 `npm run test:cdp`（连你那只)
 * 走同一份用例，不用维护两套断言。
 *
 * ## 连上去之后有三件事必须改写，否则会伤到用户
 *
 * ① **不许 close 浏览器、不许 close context** —— `browser` 夹具的默认实现结尾会
 *    `browser.close()`，对 CDP 连接来说那是**把人家窗口关掉**。这里改成只 `use()`，
 *    退出时什么都不做（断开连接由进程退出承担）。
 * ② **context 用已有的那一个**（`browser.contexts()[0]`）—— 连 CDP 的场景里
 *    `browser.newContext()` 拿不到那只窗口的登录态/主题/缩放，还会多出一个隐身的
 *    "无痕"上下文，画面看不见。
 * ③ **每个用例只开一个新标签页，跑完关掉**，并且 `bringToFront()` —— 不然窗口
 *    停在旧标签上，人看到的还是上一个用例的画面。
 *
 * ## 代价（写清楚，别当成没发生）
 *
 * 用真窗口 = 放弃用例之间的隔离：localStorage / cookie / 页面缩放都是共享的，
 * 窗口尺寸也不是 `viewport` 而是那扇窗的真实内容区。所以这条路**是给人看的**，
 * 门禁（CI、`npm run verify:full`）仍然走默认的无头夹具。
 */
import { test as base, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';

/** 设了才走 CDP；没设就是普通的 Playwright 夹具。 */
const ENDPOINT = process.env.ICE_CDP_ENDPOINT;

const cdpTest = base.extend({
  browser: async ({ playwright }, use) => {
    /**
     * `noDefaults: true` **不是可选项，是这条路的必要条件**。
     *
     * 默认情况下 Playwright 连上来会给**已存在的**默认 context 套一层自己的覆写
     * （下载行为、focus 模拟、colorScheme/reducedMotion/forcedColors/contrast 媒体模拟），
     * 第一步就是发 `Browser.setDownloadBehavior`。Chrome 153 对这个调用直接回
     * `Browser context management is not supported.` —— 于是连都连不上，
     * 报错还落在 connect 上，看起来像"CDP 端口不对"，其实是覆写被拒。
     * 这个开关就是为"接用户日常浏览器"设的：不覆写，原样用浏览器自己的设置。
     *
     * `isLocal: true`：同机（下面要读 dist/ 的产物、下载目录也同在本地），
     * 让 Playwright 走本地文件系统的那套优化。
     *
     * `timeout` 给短：端口没开或少写一位时要**响亮失败**，别让人对着空白等 30 秒。
     */
    const browser = await playwright.chromium.connectOverCDP(ENDPOINT!, {
      timeout: 15_000,
      noDefaults: true,
      isLocal: true,
    });
    await use(browser);
    // 故意不 close：那是用户自己的窗口（见文件头 ①）。
  },

  context: async ({ browser }, use) => {
    const context = browser.contexts()[0];
    if (!context) throw new Error(`CDP 连上了 ${ENDPOINT}，但那里面没有任何 context（窗口是空的？）`);
    await use(context);
    // 同样不 close：这个 context 是人家的当前窗口。
  },

  page: async ({ context, baseURL }, use) => {
    const page = await context.newPage();

    /**
     * **相对路径要自己补全**：`baseURL` 是 **context 的创建参数**，
     * 而这里复用的是人家早就建好的那个 context（事后改不了），
     * 于是 `page.goto('/')` 会直接报 `Cannot navigate to invalid URL`
     * —— 报错长得像"地址写错了"，其实是 baseURL 没落到 context 上。
     *
     * 只补这一层：`new URL(absolute, base)` 对绝对地址是恒等变换，
     * 所以 spec 里 `page.goto('/?demo=1')` 与 `goto('http://…')` 都照旧。
     */
    if (baseURL) {
      const goto = page.goto.bind(page);
      page.goto = ((url: string, options?: Parameters<typeof goto>[1]) =>
        goto(new URL(url, baseURL).toString(), options)) as typeof page.goto;
    }

    await page.bringToFront();
    await use(page);
    await page.close().catch(() => {
      // 用例自己关过页面了：这里再关一次会报 "Target closed"，无关紧要。
    });
  },
});

/**
 * 两种夹具的类型不同（CDP 那版把 `browser`/`context`/`page` 都覆盖了），
 * 但对用例来说签名一致 —— 统一成基础类型，spec 侧不需要关心走的是哪条。
 */
export const test = (ENDPOINT ? cdpTest : base) as typeof base;
export { expect };

/**
 * 这几个类型跟着一起转出来：spec 里原来写 `type Page` 是从 `@playwright/test` 拿的，
 * 换成 `./cdp` 之后那些泛型参数还在（`(page: Page) => …`），断了编译会报错。
 */
export type { BrowserContext, Locator, Page };
