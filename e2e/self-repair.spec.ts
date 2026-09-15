import { expect, test } from '@playwright/test';
import { collectErrors, readState, useChip } from './helpers';

/**
 * 自修复回路。
 *
 * agent 故意吐一份列名写错的 DSL → 客户端 `validateChartDsl` 拦下来 → 结构化诊断
 * 通过 `context` 回灌 → agent 吐修正版 → 画出来。**全程自动，用户不用再说话。**
 *
 * 这条用例的价值在于：它把 M2 会依赖的每一段都先跑通了。
 * 等换成真模型，这里的代码一行都不用动——唯一的变量只剩"模型这次吐的对不对"。
 * 而这个定位能力在 LLM 应用里最值钱，因为平时你分不清是模型的问题还是管道的问题。
 */
test('坏 DSL 被拦下 → 诊断回灌 → 自动修复', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  await useChip(page, '故意画错');

  // 等两轮 run 都跑完：第一轮吐坏的，第二轮吐修好的
  await page.waitForFunction(
    () => {
      const s = (window as any).__iceAgentConsole.getState();
      const tools = s.items.filter((i: any) => i.kind === 'tool');
      return s.status === 'idle' && tools.length === 2 && tools.every((t: any) => t.dsl);
    },
    undefined,
    { timeout: 40_000 }
  );

  const state = await readState(page);
  const tools = state.items.filter((i) => i.kind === 'tool') as any[];

  // ---- 第一张卡片：坏 DSL，没画图，列了诊断 ----
  expect(tools[0].dsl.encoding.y).toBe('销售额');
  const firstCard = page.locator('.card').first();
  await expect(firstCard).toHaveAttribute('data-status', 'error');
  await expect(firstCard.locator('.card-head .status')).toHaveText('校验不通过');
  // 诊断必须带"可用列名"，否则回灌给模型也没法修
  await expect(firstCard.locator('.diag li').first()).toContainText('销售额');
  await expect(firstCard.locator('.diag li').first()).toContainText('销量');
  await expect(firstCard.locator('.chart-wrap canvas')).toBeHidden();
  // 校验没通过的卡片不该建控件层 —— 那是第二个 ICE 实例 + 第二张画布，白占。
  // 选择器要精确到图表那张：卡片现在有多块画布（图表 + 控件条）。
  await expect(firstCard.locator('.widget-wrap canvas')).toHaveCount(0);

  // ---- 第二张卡片：修好了，画出来了 ----
  expect(tools[1].dsl.encoding.y).toBe('销量');
  const secondCard = page.locator('.card').nth(1);
  await expect(secondCard).toHaveAttribute('data-status', 'done');
  await expect(secondCard.locator('.chart-wrap canvas')).toBeVisible();
  await expect(secondCard.locator('.widget-wrap canvas')).toBeVisible();

  // 两张卡片共 3 块画布：坏的那张只有图表画布（还没建控件层），好的那张图表 + 控件各一块
  expect(await page.locator('.card canvas').count()).toBe(3);
  expect(await page.locator('.card .chart-wrap canvas').count()).toBe(2);

  const inkLast = await page.evaluate(() => {
    const list = Array.from(document.querySelectorAll('.chart-wrap canvas')) as HTMLCanvasElement[];
    const canvas = list[list.length - 1];
    const ctx = canvas.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) n++;
    return n;
  });
  expect(inkLast, '修复后的图必须真的画出来').toBeGreaterThan(1000);

  // ---- 修完之后诊断要被清掉，否则会一直挂在 context 上 ----
  expect(state.diagnostics).toBeNull();
  expect(state.status).toBe('idle');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('修好之后还能接着问下一句（修复轮不会把会话搞乱）', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await useChip(page, '故意画错');

  await page.waitForFunction(
    () => {
      const s = (window as any).__iceAgentConsole.getState();
      return s.status === 'idle' && s.items.filter((i: any) => i.kind === 'tool').length === 2;
    },
    undefined,
    { timeout: 40_000 }
  );

  await useChip(page, '看看各渠道的月度销量');
  await page.waitForFunction(
    () => (window as any).__iceAgentConsole.getState().status === 'idle',
    undefined,
    { timeout: 30_000 }
  );

  const state = await readState(page);
  // 第三张卡片，且这次没有诊断
  expect(state.items.filter((i) => i.kind === 'tool')).toHaveLength(3);
  expect(state.diagnostics).toBeNull();
  await expect(page.locator('.card')).toHaveCount(3);
  expect(errors, errors.join('\n')).toEqual([]);
});
