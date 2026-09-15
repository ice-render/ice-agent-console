import { expect, test } from '@playwright/test';
import {
  cardCanvasStats,
  clickWidgetAction,
  collectErrors,
  readState,
  settleAfter,
  useChip,
} from './helpers';

/**
 * 层：卡片里的**两块画布**。
 *
 * 图表一张、控件条一张，**两个独立的 ICE 实例**（引擎的模型就是「一层 = 一个实例 + 一张画布」）。
 * 并排关系，互不重叠，所以不需要视口同步 / 输入穿透 —— 那些只在"层叠加"时才有意义。
 *
 * 这一组用例要钉住的是：
 *  1. 两块画布都真的画出了东西（不是"元素存在但全白"）
 *  2. 控件条是**活的** —— 点它能触发 AG-UI 上行、跑出新的一轮
 *  3. 控件动作能读到 AG-UI 的 `state`（客户端回传的当前图表定义）
 */
test('卡片里有两块画布，各自都画出了内容', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  await useChip(page, '看看各渠道的月度销量');

  const stats = await cardCanvasStats(page);
  expect(stats.count, '图表 + 控件条 = 两块画布').toBe(2);
  expect(stats.chart, '图表层应当存在').not.toBeNull();
  expect(stats.widget, '控件层应当存在').not.toBeNull();

  expect(stats.chart!.ink, '图表画布要有实际绘制内容').toBeGreaterThan(1000);
  expect(stats.widget!.ink, '控件条画布要有实际绘制内容（按钮真的画出来了）').toBeGreaterThan(1000);

  // 两块画布宽度一致（同一张卡片、同一个可用宽度），高度不同（图表高、控件条矮）
  expect(stats.widget!.width).toBe(stats.chart!.width);
  expect(stats.widget!.height).toBeLessThan(stats.chart!.height);

  // 控件层是**另一张 canvas 元素**，不是图表那张
  const sameElement = await page.evaluate(() => {
    const card = document.querySelector('.card')!;
    const a = card.querySelector('.chart-wrap canvas');
    const b = card.querySelector('.widget-wrap canvas');
    return a === b;
  });
  expect(sameElement).toBe(false);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('点控件条上的按钮触发一轮新 run（上行来自第二块画布）', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  const before = await useChip(page, '看看各渠道的月度销量');
  const textBefore = before.items.filter((i) => i.kind === 'text').length;

  // 「解释这张图」读的是 AG-UI 的 state —— 客户端把当前图表定义回传给了 agent
  const after = await settleAfter(page, async () => {
    await clickWidgetAction(page, 'explain');
    await expect(page.locator('.msg.user').last()).toContainText('解释一下这张图', { timeout: 5000 });
  });

  expect(after.runId).not.toBe(before.runId);
  expect(after.threadId).toBe(before.threadId);
  expect(after.items.filter((i) => i.kind === 'text').length).toBeGreaterThan(textBefore);

  const reply = after.items.filter((i) => i.kind === 'text').slice(-1)[0] as any;
  expect(reply.text, '回复应当是从 state 读出来的图表定义').toContain('state');
  expect(reply.text).toContain('类型：bar');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('「换个画法」读 state 换类型 —— 同一份数据、新卡片、新类型', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  const before = await useChip(page, '看看各渠道的月度销量');
  expect(before.sharedState.chart.kind).toBe('bar');
  const rowsBefore = before.sharedState.chart.data.rows.length;

  const after = await settleAfter(page, async () => {
    await clickWidgetAction(page, 'redraw');
    await expect(page.locator('.msg.user').last()).toContainText('换个画法', { timeout: 5000 });
  });

  // 新卡片：类型换了，但**数据一行没动**（agent 是从 state 里读的当前图表，不是重新造的）
  expect(after.sharedState.chart.kind).toBe('line');
  expect(after.sharedState.chart.data.rows).toEqual(before.sharedState.chart.data.rows);
  expect(after.sharedState.chart.data.rows.length).toBe(rowsBefore);

  expect(after.items.filter((i) => i.kind === 'tool')).toHaveLength(2);
  await expect(page.locator('.card')).toHaveCount(2);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('控件动作照旧走 context 通道（不是拼在用户说的话里）', async ({ page }) => {
  await page.goto('/');
  await useChip(page, '看看各渠道的月度销量');

  const after = await settleAfter(page, async () => {
    await clickWidgetAction(page, 'stream');
    // 气泡里是**发给 agent 的那句话**（按钮文案是短标签，两者本来就不必相同）
    await expect(page.locator('.msg.user').last()).toContainText('实时吞吐量', { timeout: 5000 });
  });

  // 「看实时数据」走的是流式剧本：折线 + 逐拍追加
  expect(after.sharedState.chart.kind).toBe('line');
  expect(after.sharedState.chart.data.rows.length).toBeGreaterThan(6);
  await expect(page.locator('.card')).toHaveCount(2);
});
