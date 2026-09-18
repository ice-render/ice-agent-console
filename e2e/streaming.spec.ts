import { expect, test } from '@playwright/test';
import {
  CHART_CANVAS,
  TOOL_ENTRY,
  canvasSignature,
  chipLocator,
  collectErrors,
  countInk,
  readStage,
  readState,
  useChip,
  waitForState,
} from './helpers';

/**
 * 流式追加：`STATE_DELTA` → `appendData` 快路径。
 *
 * 这个剧本的 x 轴刻意用**数值轴**（秒）而不是类目轴，因为 `appendData` 只往
 * `series.data` 末尾 concat、不碰 `xAxis.data`——类目轴上追加新类目会错位。
 * 视图层对此有防御（认出类目轴就退回全量重绘，见 src/domain/ice/option-mapping.ts），
 * 这里的用例走的是快路径那一支。
 *
 * 布局反转之后这一组的分量更重了：追加是"在**同一块画布**上长"，
 * 而这件事现在是**结构性保证**的 —— 图表宿主只建一次，`STATE_DELTA` 永远落在它身上。
 */
test('数据一拍一拍追加进同一张图', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  const before = await readState(page);
  await chipLocator(page, '看看出水实时流量').click();

  // 等第一次上画布：STATE_SNAPSHOT 在 TOOL_CALL_END **之后**到，
  // 所以"条目 done"不等于"状态已就绪"——要单独等一次。
  await waitForState(page, (s) => s.sharedState !== null, undefined, 30_000);
  const initial = await readState(page);
  expect(initial.sharedState.chart.data.rows).toHaveLength(6);
  expect(initial.sharedState.chart.encoding.x).toBe('时刻(秒)');
  // 量级是"一座 10 万 m³/日污水厂的出水流量"（日均 ≈ 4167 m³/h），不是随便画的两位数
  expect(initial.sharedState.chart.data.rows[0][1]).toBeGreaterThan(1000);

  const signatureBefore = await canvasSignature(page, CHART_CANVAS);

  await waitForState(page, (s, min) => s.status === 'idle' && s.eventCount > min, before.eventCount, 30_000);
  const final = await readState(page);

  // 三拍各追加一个点，表长到 9，且追加的是数值轴上的新采样
  expect(final.sharedState.chart.data.rows).toHaveLength(9);
  expect(final.sharedState.chart.data.rows.slice(6)).toEqual([
    [7, 4428],
    [8, 4494],
    [9, 4176],
  ]);

  // 画面确实变了（新点画上去了），而且**始终只有一层图**——
  // 追加不该新建图层，那会把"同一张图在长"变成"多张图"
  expect(await canvasSignature(page, CHART_CANVAS)).not.toBe(signatureBefore);
  const stage = await readStage(page);
  expect(stage.builds.chart, '追加不该重建图表宿主').toBe(1);
  expect(await countInk(page, CHART_CANVAS)).toBeGreaterThan(1000);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('追加之后图还能交互（快路径不该把监听弄丢）', async ({ page }) => {
  // 这一条盯的是"不要用 renderChartDsl"那个坑：它每次重建实例，
  // 挂在上面的监听会随之丢失，症状是"第 N 次更新之后点了没反应"。
  //
  // 用框选而不是点数据点：折线图的命中区只有几个像素宽，点不中会变成
  // 一条随机红的用例。框选在绘图区任意位置都能触发，同样走 wireInteractions。
  // （item:click 的覆盖在 round-trip.spec.ts 里，那边是柱状图，命中区够大。）
  const errors = collectErrors(page);
  await page.goto('/');

  const before = await readState(page);
  await chipLocator(page, '看看出水实时流量').click();
  await waitForState(
    page,
    (s, min) => s.status === 'idle' && s.eventCount > min,
    before.eventCount,
    30_000
  );

  const rowsAfterAppend = (await readState(page)).sharedState.chart.data.rows.length;
  expect(rowsAfterAppend).toBe(9);

  const canvas = page.locator(CHART_CANVAS).first();
  const box = (await canvas.boundingBox())!;

  const base = await readState(page);
  const y = box.y + box.height * 0.5;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, y, { steps: 12 });
  await page.mouse.move(box.x + box.width * 0.65, y, { steps: 12 });
  await page.mouse.up();

  await expect(page.locator('.msg.user').last()).toContainText('框选', { timeout: 5000 });
  await waitForState(
    page,
    (s, min) => s.status === 'idle' && s.eventCount > min,
    base.eventCount,
    30_000
  );

  // 交互触发了新一轮，但那张图没被搞坏
  const after = await readState(page);
  expect(after.sharedState.chart.data.rows).toHaveLength(9);
  await expect(page.locator(TOOL_ENTRY)).toHaveCount(1);
  expect((await readStage(page)).builds.chart).toBe(1);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('第二轮的条目不会顶掉第一轮的（跨轮 id 唯一）', async ({ page }) => {
  await page.goto('/');
  await useChip(page, '看看出水实时流量');
  await useChip(page, '看看出水 COD 的趋势');

  const state = await readState(page);
  const ids = state.items.map((i) => i.id);
  expect(new Set(ids).size, 'id 必须唯一，否则前端按 id 复用元素会互相覆盖').toBe(ids.length);
  await expect(page.locator(TOOL_ENTRY)).toHaveCount(2);
});
