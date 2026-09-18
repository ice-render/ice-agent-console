/**
 * 消息流的两条新行为（真实浏览器）：
 *
 * ① **「正在思考」那一行**：本地模型动不动就一两分钟，「我发了一句话然后什么都没发生」
 *    是最难受的状态。它必须在 run 一开始出现、在有内容时消失；
 * ② **Markdown 渲染**：模型的回答天然带加粗 / 列表 / 代码块，整段 `textContent` 写进去
 *    会把这些标记原样显示出来。这里钉住"助手气泡里是**节点**，不是标记文本"。
 *
 * 走 `?demo=1`（页面内跑同一份剧本，26ms/字的节奏）：不依赖任何后端，
 * 节奏又足够长，能稳定观察到"等待中"这个中间态。
 */
import { expect, test, type Page } from '@playwright/test';
import { readState } from './helpers';

/** 页面里的错误收集器：任何一条 console.error / pageerror 都算失败。 */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message.split('\n')[0]));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push('console.error: ' + msg.text().slice(0, 200));
  });
  return errors;
}

test('等待模型时显示「正在思考」，有内容后收起', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?demo=1&autoplay=0');
  await page.waitForSelector('#input', { timeout: 20_000 });

  /**
   * 「出现过」比「现在还在」更可靠。
   *
   * 剧本模式是**秒回**的：run 开始到第一段文字之间只有几十毫秒，
   * 用 `expect(pending).toBeVisible()` 去轮询会有概率整个窗口都错过（flaky）。
   * 这里装一个 MutationObserver 把它记下来 —— 判据仍然是"真的出现过"，
   * 只是不再依赖"恰好被采到"。真实模型那一侧不需要这招：等待是分钟级的。
   */
  await page.evaluate(() => {
    (window as any).__sawPending = false;
    const root = document.querySelector('#thread') as HTMLElement;
    new MutationObserver(() => {
      if (root.querySelector('.pending')) (window as any).__sawPending = true;
    }).observe(root, { childList: true, subtree: true });
  });

  await page.fill('#input', '看看污水处理工艺图');
  await page.press('#input', 'Enter');

  // ① 助手内容到手（先等结果，再回来看"等待提示出现过没有"）
  const assistantBubble = page.locator('.msg.assistant .bubble').first();
  await expect(assistantBubble).toBeVisible({ timeout: 30_000 });
  await expect(assistantBubble).not.toBeEmpty();
  expect(await page.evaluate(() => (window as any).__sawPending), 'run 期间应当出现过「正在思考」').toBe(true);

  // ② 有内容之后必须收起 —— 不能与正文并排挂着（那看着像还有第二个任务在跑）
  await expect(page.locator('.pending')).toHaveCount(0);

  expect(errors, `页面出现错误：\n${errors.join('\n')}`).toEqual([]);
});

test('助手气泡渲染 Markdown 结构（不是把标记原样显示）', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?demo=1&autoplay=0');
  await page.waitForSelector('#input', { timeout: 20_000 });

  await page.fill('#input', '看看出水 COD 的趋势');
  await page.press('#input', 'Enter');

  const bubble = page.locator('.msg.assistant .bubble').first();
  await expect(bubble).toBeVisible({ timeout: 30_000 });
  await expect(bubble.locator('p').first()).toBeVisible();

  // 用户气泡保持纯文本原样：敲进去的星号就是星号。
  // ⚠️ 必须**等上一轮跑完**再发：run 进行中 send 会被护栏挡掉（这是既有语义，
  //    自动开演之外的抢跑都走"先取消再发"，这里只是普通追加，所以等它自己走完）。
  await expect.poll(async () => (await readState(page)).status, { timeout: 40_000 }).toBe('idle');
  await page.fill('#input', '**这不是加粗**');
  await page.press('#input', 'Enter');
  const userBubble = page.locator('.msg.user .bubble').last();
  await expect(userBubble).toHaveText('**这不是加粗**', { timeout: 15_000 });

  expect(errors, `页面出现错误：\n${errors.join('\n')}`).toEqual([]);
});
