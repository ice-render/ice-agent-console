import { expect, test } from '@playwright/test';
import {
  CHART_CANVAS,
  WIDGET_CANVAS,
  clickWidgetAction,
  collectErrors,
  readStage,
  settleAfter,
  stageStats,
  useChip,
} from './helpers';

/**
 * 层：**图表图层里的两块画布**。
 *
 * 图表一张、控件条一张，**两个独立的 ICE 实例**（引擎的模型就是「一层 = 一个实例 + 一张画布」）。
 * 控件条浮在绘图区底部，与图表互不重叠，所以不需要视口同步 / 输入穿透 ——
 * 那些只在"层叠加"时才有意义。
 *
 * 布局反转后这一组的意义变了：两块画布不再属于"一张卡片"，而属于**同一层**。
 * 而且图层是会被顶掉的（切回工艺图时图表层整个销毁），所以这里顺便钉住那条生命周期。
 *
 * 这一组用例要钉住的是：
 *  1. 两块画布都真的画出了东西（不是"元素存在但全白"）
 *  2. 控件条是**活的** —— 点它能触发 AG-UI 上行、跑出新的一轮
 *  3. 控件动作能读到 AG-UI 的 `state`（客户端回传的当前图表定义）
 */
test('图表图层里有两块画布，各自都画出了内容', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  await useChip(page, '看看出水 COD 的趋势');

  const stats = await stageStats(page);
  expect(stats.chart, '图表画布应当存在').not.toBeNull();
  expect(stats.widget, '控件条画布应当存在').not.toBeNull();

  expect(stats.chart!.ink, '图表画布要有实际绘制内容').toBeGreaterThan(1000);
  expect(stats.widget!.ink, '控件条画布要有实际绘制内容（按钮真的画出来了）').toBeGreaterThan(1000);

  // 两块画布**差不多**宽（都铺在绘图区上），但控件条自己有 1px 边框，
  // 所以内容盒比图表窄 2px —— 用容差而不是相等（写相等等于把边框当成缺陷）。
  expect(Math.abs(stats.widget!.width - stats.chart!.width)).toBeLessThanOrEqual(4);
  expect(stats.widget!.height).toBeLessThan(stats.chart!.height);

  // 控件条是**另一张 canvas 元素**，不是图表那张
  const sameElement = await page.evaluate(
    ([chartSel, widgetSel]) => document.querySelector(chartSel) === document.querySelector(widgetSel),
    [CHART_CANVAS, WIDGET_CANVAS]
  );
  expect(sameElement).toBe(false);

  // 同一时刻绘图区**显示**的只有 chart 这一层。
  // 工艺图那一层仍然在（`hidden`）—— 它是主视图，设计上永不销毁。
  const stage = await readStage(page);
  expect(stage.active).toBe('chart');
  expect(stage.layers.sort()).toEqual(['chart', 'diagram']);
  expect(stage.builds.diagram).toBe(1);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('点控件条上的按钮触发一轮新 run（上行来自第二块画布）', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  const before = await useChip(page, '看看出水 COD 的趋势');
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
  // 不只是"念了一遍定义"，而是**读出了数据再讲**：均值与峰值都是那张图里的真数
  // （只有真的拿到 state 里的 rows 才算得出来，靠猜写不出 36.3 这个值）
  expect(reply.text).toContain('bar');
  expect(reply.text).toContain('均值 36.3');
  expect(reply.text).toContain('46');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('「换个画法」读 state 换类型 —— 同一份数据、同一个图层、换类型', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  const before = await useChip(page, '看看出水 COD 的趋势');
  expect(before.sharedState.chart.kind).toBe('bar');
  const rowsBefore = before.sharedState.chart.data.rows.length;
  const stageBefore = await readStage(page);
  expect(stageBefore.builds.chart).toBe(1);

  const after = await settleAfter(page, async () => {
    await clickWidgetAction(page, 'redraw');
    await expect(page.locator('.msg.user').last()).toContainText('换个画法', { timeout: 5000 });
  });

  // 类型换了，但**数据一行没动**（agent 是从 state 里读的当前图表，不是重新造的）
  expect(after.sharedState.chart.kind).toBe('line');
  expect(after.sharedState.chart.data.rows).toEqual(before.sharedState.chart.data.rows);
  expect(after.sharedState.chart.data.rows.length).toBe(rowsBefore);

  // ★ 绘图区**没有新建图层** —— 图表宿主被复用（`setOption` 换数据而不是重建实例）。
  //   这是布局反转之后"同一个东西留在原地"最直接的一个读数。
  const stageAfter = await readStage(page);
  expect(stageAfter.builds.chart, '图表宿主应当被复用而不是重建').toBe(1);
  expect(stageAfter.active).toBe('chart');

  // 对话里两条工具条目，但绘图区上仍然只有一块图表画布
  expect(after.items.filter((i) => i.kind === 'tool')).toHaveLength(2);
  await expect(page.locator('.tool-entry')).toHaveCount(2);
  const stats = await stageStats(page);
  expect(stats.chart, '仍然只有一块图表画布').not.toBeNull();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('控件动作照旧走 context 通道（不是拼在用户说的话里）', async ({ page }) => {
  await page.goto('/');
  await useChip(page, '看看出水 COD 的趋势');

  const after = await settleAfter(page, async () => {
    await clickWidgetAction(page, 'stream');
    // 气泡里是**发给 agent 的那句话**（按钮文案是短标签，两者本来就不必相同）
    await expect(page.locator('.msg.user').last()).toContainText('实时流量', { timeout: 5000 });
  });

  // 「看实时数据」走的是流式剧本：折线 + 逐拍追加
  expect(after.sharedState.chart.kind).toBe('line');
  expect(after.sharedState.chart.data.rows.length).toBeGreaterThan(6);
  await expect(page.locator('.tool-entry')).toHaveCount(2);
});
