import { expect, test } from '@playwright/test';
import {
  CHART_CANVAS,
  TOOL_ENTRY,
  WIDGET_CANVAS,
  collectErrors,
  countInk,
  readStage,
  readState,
  useChip,
} from './helpers';

/**
 * 自修复回路。
 *
 * agent 故意吐一份列名写错的 DSL → 客户端 `validateChartDsl` 拦下来 → 结构化诊断
 * 通过 `context` 回灌 → agent 吐修正版 → 画出来。**全程自动，用户不用再说话。**
 *
 * 这条用例的价值在于：它把 M2 会依赖的每一段都先跑通了。
 * 等换成真模型，这里的代码一行都不用动——唯一的变量只剩"模型这次吐的对不对"。
 * 而这个定位能力在 LLM 应用里最值钱，因为平时你分不清是模型的问题还是管道的问题。
 *
 * 布局反转之后这里多了一条**新**语义：失败的那一轮**不切画面**。
 * 绘图区保持原样（开页的工艺图还在），诊断只落在对话里的那条条目上 ——
 * 旧行为是"卡片亮着、画布空白"，那会让人以为图坏了（其实坏的是 DSL，而且马上就要修）。
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

  // ---- 第一条条目：坏 DSL，没上绘图区，列了诊断 ----
  expect(tools[0].dsl.encoding.y).toBe('销售额');
  const firstEntry = page.locator(TOOL_ENTRY).first();
  await expect(firstEntry).toHaveAttribute('data-status', 'error');
  await expect(firstEntry.locator('.card-head .status')).toHaveText('校验不通过');
  // 诊断必须带"可用列名"，否则回灌给模型也没法修
  await expect(firstEntry.locator('.diag li').first()).toContainText('销售额');
  await expect(firstEntry.locator('.diag li').first()).toContainText('销量');

  // ★ 两次 tool call，但图表图层**只建过一次**。
  //   这就是"失败那一轮没上画布"的**非竞态**证法：要在坏的那一轮当场量状态是做不到的
  //   （第一轮刚结束、第二轮紧接着就自动开始了），而"总共只 build 过一次"是终值，
  //   零时序依赖 —— 坏的那一轮要是建了层，这里会是 2。
  const afterRepair = await readStage(page);
  expect(afterRepair.active).toBe('chart');
  expect(afterRepair.builds.chart, '两次调用只该建出一个图表图层').toBe(1);
  expect(afterRepair.shows.chart, '只有成功的那一次显示过').toBe(1);

  // ---- 第二条条目：修好了，画出来了 ----
  expect(tools[1].dsl.encoding.y).toBe('销量');
  const secondEntry = page.locator(TOOL_ENTRY).nth(1);
  await expect(secondEntry).toHaveAttribute('data-status', 'done');
  await expect(page.locator(CHART_CANVAS)).toBeVisible();
  // 控件条是跟着"图真的画出来了"才亮的，所以它出现本身就说明这次上了画布
  await expect(page.locator(WIDGET_CANVAS)).toBeVisible();
  expect(await countInk(page, CHART_CANVAS), '修复后的图必须真的画出来').toBeGreaterThan(1000);

  // 绘图区上活着的是图表这两块画布 + 工艺图那一块（`hidden`，主视图永不销毁）。
  // 关键是**没有"每张卡片各留一块"**那种堆积。
  expect(afterRepair.canvasCount, '不活动的图层被收干净了').toBe(3);

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
  // 第三条条目，且这次没有诊断
  expect(state.items.filter((i) => i.kind === 'tool')).toHaveLength(3);
  expect(state.diagnostics).toBeNull();
  await expect(page.locator(TOOL_ENTRY)).toHaveCount(3);

  // 三条条目、两块画布 —— 图层数跟条目数**不成正比**（这正是"不用每次重画"的读数）
  const stage = await readStage(page);
  expect(stage.builds.chart, '后面那次是复用同一个图表宿主').toBe(1);
  expect(errors, errors.join('\n')).toEqual([]);
});
