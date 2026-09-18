import { expect, test } from '@playwright/test';
import { CHART_CANVAS, clickChartItem, collectErrors, countInk, readState, readStage, settleAfter, useChip } from './helpers';

/**
 * 往返回路：**用户在图上做的事，变成新一轮 run**。
 *
 * 这条回路是这个工程存在的理由。它证明了 AG-UI 是双向的——
 * 图表不是"Agent 画给用户看的图片"，而是"人和 Agent 共用的工作面"。
 */

test('点击数据点触发一轮新 run，且交互通过 context 上报', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  const before = await useChip(page, '看看出水 COD 的趋势');
  const textBefore = before.items.filter((i) => i.kind === 'text').length;

  // canvas 里没有 DOM 目标可定位，所以按实测位置依次尝试（见 helpers.clickChartItem）
  let hit = false;
  const after = await settleAfter(page, async () => {
    hit = await clickChartItem(page);
    // 用户气泡是本地乐观插入的，应当立刻出现——出现了才说明上行被接住了
    await expect(page.locator('.msg.user').last()).toContainText('我点了', { timeout: 5000 });
  });

  expect(hit, '没能在图表上点中任何数据点').toBe(true);
  expect(after.runId).not.toBe(before.runId);
  expect(after.threadId).toBe(before.threadId);
  expect(after.items.filter((i) => i.kind === 'text').length).toBeGreaterThan(textBefore);

  // Agent 确实读到了交互内容，而不是只看到一句没有上下文的话
  const reply = after.items.filter((i) => i.kind === 'text').slice(-1)[0] as any;
  expect(reply.text).toContain('context');
  expect(reply.text).toMatch(/点了/);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('框选区间触发一轮新 run', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  await useChip(page, '看看出水 COD 的趋势');

  const canvas = page.locator(CHART_CANVAS).first();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  const after = await settleAfter(page, async () => {
    const y = box!.y + box!.height * 0.55;
    await page.mouse.move(box!.x + box!.width * 0.25, y);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width * 0.42, y, { steps: 12 });
    await page.mouse.move(box!.x + box!.width * 0.58, y, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('.msg.user').last()).toContainText('框选', { timeout: 5000 });
  });

  const reply = after.items.filter((i) => i.kind === 'text').slice(-1)[0] as any;
  expect(reply.text).toMatch(/框选|区间/);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('点击不会破坏已有图表（上行不该有副作用）', async ({ page }) => {
  await page.goto('/');
  await useChip(page, '看看出水 COD 的趋势');

  const hit = await settleAfter(page, async () => {
    if (!(await clickChartItem(page))) throw new Error('没能在图表上点中任何数据点');
    await expect(page.locator('.msg.user').last()).toContainText('我点了', { timeout: 5000 });
  });
  expect(hit.status).toBe('idle');

  // 图表还在、还是那一层、还在画东西。
  // ★ `builds.chart` 不变是这一条的要点：点击是**上行**，它只跑新一轮解析，
  //   不该在绘图区上新建图层（新建就意味着"点一下重画一次"）。
  const stage = await readStage(page);
  expect(stage.active).toBe('chart');
  expect(stage.builds.chart).toBe(1);
  const state = await readState(page);
  expect(state.sharedState.chart.kind).toBe('bar');
  expect(await countInk(page, CHART_CANVAS)).toBeGreaterThan(1000);
});
