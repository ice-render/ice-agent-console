/**
 * **演示模式**：不需要后端也能把整套回路演出来。
 *
 * 这是"能扔到 GitHub Pages 上做演示站点"的**唯一可信证明**。
 *
 * ## 判据不是"画面看起来对"
 *
 * 演示模式下画面**本来就该**与连后端时一模一样（走的是同一份 `ScriptedAgent`，
 * 事件流逐字节相同）。所以"看着对"证明不了任何事 —— 它可能只是悄悄连上了本地后端。
 *
 * 真正要钉的是：**一个到 8099 的请求都没发出去**。所以这里把后端请求全部 abort 掉，
 * 再断言请求集合为空。加上这一条之后，"演示模式能工作"才跟"这台机器上碰巧起着后端"
 * 区分开来。
 *
 * ## 为什么反面用例同样重要
 *
 * 只断言"没发请求"是不够的：一个**彻底坏掉的**前端（比如根本没绑上事件、
 * 或者 transport 被写死成空函数）同样不发请求。所以还要跑一条 `?demo=0`，
 * 断言它**确实**去连了 8099 —— 两边合起来才说明"开关真的在切换 transport"，
 * 而不是"这条路上什么都不发生"。
 *
 * ## 测的是普通构建的产物
 *
 * `?demo=1` 是**运行期覆盖**，所以不需要 `build:demo` 的产物，
 * 跑在 `npm run build` 出来的 `dist/` 上就行（与其余 spec 同一份产物）。
 * `playwright.config.ts` 的 `webServer` 数组因此不用改 —— 其余 spec 仍需要 8099。
 *
 * ## ⚠️ e2e 跑起来时**后端是活的**
 *
 * `playwright.config.ts` 的 `webServer` 数组会起 8099。这对这条 spec 反而是好事：
 * "演示模式一个 8099 请求都没发"才成为一个**有意义**的断言 ——
 * 后端就在那儿等着，是 transport 选择让它没被碰。
 *
 * 也正因为后端活着，`?demo=0` **不会**失败。所以反面用例断言的不是"报错了"，
 * 而是"**真的连上了后端**并且跑通了"—— 这比等一个错误强：它同时证明了
 * 那条路上确实有东西在发生。
 */
// `./cdp` 平时就是 `@playwright/test`（无头、自己起浏览器），
// 只有设了 `ICE_CDP_ENDPOINT` 时才改成连你开着的那只 Chrome —— 见 `e2e/cdp.ts`。
import { expect, test, type Page } from './cdp';
import {
  TOOL_ENTRY,
  chatScroll,
  chipLocator,
  collectErrors,
  fillForm,
  readState,
  settleAfter,
  useChip,
  waitDiagramReady,
  waitForState,
} from './helpers';

/** 到后端的请求（8099）。收集起来用于断言"一个都没发"。 */
function trackBackendRequests(page: Page): string[] {
  const hits: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('8099')) hits.push(req.url());
  });
  return hits;
}

/** `evaluate` 里用的调试口形状（`runMode` 是新加的）。 */
async function runMode(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__iceAgentConsole.runMode());
}

test('★ 演示模式：零后端请求，但四类回路全部跑得通', async ({ page }) => {
  const errors = collectErrors(page);

  // ⚠️ 后端根本没起（这个 spec 由 `?demo=1` 保证不会去连它）——
  //    万一代码退回连后端，请求会失败，下面第一条断言就会抓到。
  const backendHits = trackBackendRequests(page);

  await page.goto('/?demo=1');
  await waitDiagramReady(page);

  // ---- ① 模式判定生效 ----
  expect(await runMode(page)).toBe('demo');

  // ---- ② 一个到 8099 的请求都没发 ----
  // 开页就画了工艺图（那是纯前端的事），所以这一条此时已经可以断言
  expect(backendHits, `演示模式不该发出任何后端请求，实际发了：${backendHits.join(', ')}`).toEqual([]);

  // ---- ③ 主链路：提问 → 出图 → 指着讲 ----
  // ⚠️ 用 `useChip` 而不是 `chipLocator().click()` + `waitSettled(page, 1)`：
  //    后者会**立刻返回**（eventCount 早就 >= 1 了，状态也还是上一轮的 idle），
  //    于是量到的是"这一轮还没开始"的状态。`settleAfter` 会先记基线再等它涨过基线。
  const state = await useChip(page, '看看出水 COD 的趋势');
  expect(state.status).toBe('idle');
  expect(state.sharedState.chart.kind).toBe('bar');
  expect(state.pointAt, '剧本里的「指着讲」应当也走通了').not.toBeNull();
  await expect(page.locator(`${TOOL_ENTRY} .hint`)).toContainText('分片流式传完');

  // ---- ④ 改图：`STATE_DELTA` 增量增删也要能走通（不只是"画一张图"） ----
  const afterUpgrade = await useChip(page, '提标改造');
  const ids = afterUpgrade.sharedState.diagram.units.map((u: any) => u.id);
  expect(ids, '提标改造应当真的改了图（演示模式下也一样）').toContain('ozone');
  expect(ids).not.toContain('primary');

  // ---- ⑤ 中断 → 填表 → resume 这条协议通道在演示模式下同样通 ----
  await chipLocator(page, '给进水泵下发指令').click();
  await waitForState(page, (s) => s.status === 'waiting', undefined, 30_000);
  const waiting = await readState(page);
  expect(waiting.interrupt).toMatchObject({ id: 'confirm-params' });

  const resumed = await settleAfter(page, async () => {
    await fillForm(page, { station: 'pump-2', mode: 'manual', flow: 1200, note: '例检' });
    const point = await page.evaluate(() => (window as any).__iceAgentConsole.formSubmitPoint());
    expect(point, '表单提交按钮的坐标应当拿得到').not.toBeNull();
    await page.mouse.click(point!.x, point!.y);
  });
  expect(resumed.interrupt, '答复完中断要被清掉').toBeNull();
  expect(resumed.status).toBe('idle');

  // ---- ⑥ meta 里标出了演示模式 ----
  await expect(page.locator('#meta')).toContainText('演示模式');

  // 全程仍然没有一个后端请求
  expect(backendHits, `演示模式不该发出任何后端请求，实际发了：${backendHits.join(', ')}`).toEqual([]);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('★ 反面：同一份产物用 ?demo=0 会**真的**走后端（而且跑得通）', async ({ page }) => {
  // 少了这一条，"演示模式没发请求"可能只是因为这条路上什么都不发生。
  // 有了它，两边合起来才说明开关真的在切换 transport。
  //
  // 断言的是"连上后端并跑通"而不是"报错了"：e2e 跑起来时后端是活的（见文件头），
  // 所以正确行为就是**成功**。而"请求确实发出去了"由 `backendHits` 保证。
  const backendHits = trackBackendRequests(page);

  await page.goto('/?demo=0');
  await waitDiagramReady(page);

  expect(await runMode(page)).toBe('server');
  await expect(page.locator('#meta')).not.toContainText('演示模式');

  const state = await useChip(page, '看看出水 COD 的趋势');
  expect(state.status, 'server 模式应当正常跑通（后端是活的）').toBe('idle');
  expect(state.sharedState.chart.kind).toBe('bar');

  expect(backendHits.length, 'server 模式应当真的发了后端请求').toBeGreaterThan(0);
  expect(backendHits.some((u) => u.includes('/agui')), '应当打到 /agui 端点').toBe(true);
});

test('★ 普通产物（不加参数）默认走 server —— 与加这个开关之前一致', async ({ page }) => {
  const backendHits = trackBackendRequests(page);
  await page.goto('/');
  await waitDiagramReady(page);

  expect(await runMode(page), '普通构建的默认模式必须还是 server').toBe('server');
  await expect(page.locator('#meta')).not.toContainText('演示模式');

  const state = await useChip(page, '看看出水 COD 的趋势');
  expect(state.status).toBe('idle');
  expect(backendHits.length, '默认模式应当去连后端').toBeGreaterThan(0);
});

test('演示模式下消息流同样自动滚到底（与真环境一致）', async ({ page }) => {
  // 演示站点里最容易被察觉的差异就是"滚动行为不一样" ——
  // 而它走的是同一份 `ChatView`，所以这里顺带钉一下。
  const errors = collectErrors(page);
  await page.goto('/?demo=1');
  await waitDiagramReady(page);

  await useChip(page, '看看污水处理工艺图');

  const scroll = await chatScroll(page);
  expect(scroll.scrollHeight, '内容应当溢出').toBeGreaterThan(scroll.clientHeight);
  expect(scroll.fromBottom, '演示模式下也该跟到底部').toBeLessThanOrEqual(8);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('★ 连不上后端时，对话流里要有一张说明卡片（不能只在顶栏留一行小字）', async ({ page }) => {
  // 回归：这条路上原先**对话里一片空白** —— 用户看到的只是"我发了一句话，然后什么都没发生"，
  // 像 AI 不理人。`state.error` 一直存在，但只被拼进了顶栏 meta 的那行小字
  // （`… · 工具 0 · 出错 · Failed to fetch`），又小又挤。
  // 实测场景：打开静态演示站点并加上 `?demo=0`（于是走后端那条 transport，而站点上没有后端），
  // 点任意按钮都会停在这个状态。
  //
  // e2e 跑起来时后端是活的，所以**主动把 /agui 掐掉**来造这个失败 ——
  // 这比依赖"某个端口恰好没起"确定得多，也让这条用例在本地与 CI 行为一致。
  await page.route('**/agui', (route) => route.abort());

  await page.goto('/?demo=0');
  await waitDiagramReady(page);

  await chipLocator(page, '看看出水 COD 的趋势').click();
  await waitForState(page, (s) => s.status === 'error');

  // ① 提示必须落在**对话流里**（`#thread` 内），而且给得出下一步动作
  const notice = page.locator('#thread .error-notice');
  await expect(notice).toHaveCount(1);
  await expect(notice.locator('.error-title')).toContainText('没能连上 agent');
  await expect(notice.locator('.error-hint')).toContainText('?demo=1');
  // ② 原始报错要留着（给开发者查原因用），不能只给一句人话
  await expect(notice.locator('.error-detail')).not.toBeEmpty();

  // ③ 顶栏那行也要在 —— 两处各有各的用处（顶栏常驻、对话流里能引导）
  await expect(page.locator('#meta')).toContainText('出错');

  // ④ 提示卡不该被算成"消息条目"：它是状态，不是 thread 里的一条消息
  const state = await readState(page);
  expect(state.error).toBeTruthy();
  expect(
    state.items.filter((i) => i.kind === 'text' && i.text?.includes('?demo=1')).length,
    '提示卡不该伪装成一条消息塞进 items'
  ).toBe(0);
});
