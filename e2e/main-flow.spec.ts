import { expect, test } from '@playwright/test';
import {
  CHART_CANVAS,
  DIAGRAM_CANVAS,
  TOOL_ENTRY,
  canvasSignature,
  collectErrors,
  countInk,
  readStage,
  readState,
  settleAfter,
  useChip,
  waitForState,
  waitSettled,
} from './helpers';

/**
 * 主链路：问一句 → 文字流式 → 工具条目里参数流式拼装 → 上绘图区 → 指着讲 → 结束。
 *
 * 一条用例把 Thread 式生成 UI 的每一段都走一遍。**注意判据不是"DOM 里有 canvas"，
 * 而是"画布上真的有墨"**——canvas 元素存在但全白是很典型的一种失败，
 * 只看元素是否存在会漏掉它。
 *
 * 与旧版的差别：开页时画布**已经存在**（工艺图铺满视口），所以"上画布"这件事
 * 变成了"切图层"——断言里要分清"哪一层的画布"。
 */
test('主链路：文字流式 → 绘图区出图 → 指着讲', async ({ page }) => {
  const errors = collectErrors(page);

  await page.goto('/');

  // 开页就是工艺图 —— 绘图区不空，但对话里还一条条目都没有
  const bootStage = await readStage(page);
  expect(bootStage.active).toBe('diagram');
  await expect(page.locator('.empty')).toBeVisible();
  await expect(page.locator(TOOL_ENTRY)).toHaveCount(0);

  const before = await readState(page);
  await page.locator('.chip', { hasText: '看看各渠道的月度销量' }).first().click();

  // ---- 文字是流式的：跟着归约状态采样，长度应当出现过多个值 ----
  // 直接读状态而不是读第一个 `.bubble`——第一个气泡是本地插入的用户消息，
  // 它一开始就是完整文本，拿它采样永远看不到"逐段到达"。
  //
  // **采到两个不同长度就退出**，不要等整轮跑完：后面还要在"高亮之前"取画布快照，
  // 在这里等到 idle 的话，那一步取到的就已经是高亮之后了。
  // （早先这版就是等 idle 的 —— 它能过是因为高亮的淡入动画还没结束、
  //  两次采样恰好不同。加了控件层之后时序一变就变成确定性失败。）
  const assistantLengths = new Set<number>();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && assistantLengths.size < 2) {
    const snapshot = await readState(page);
    const joined = snapshot.items
      .filter((i) => i.kind === 'text' && i.text !== undefined)
      .map((i) => i.text!.length)
      .join(',');
    assistantLengths.add(joined.length);
    await page.waitForTimeout(25);
  }
  expect(assistantLengths.size, '文字应当逐段到达，而不是一次到位').toBeGreaterThan(1);

  // ---- tool 条目出现，参数先经历"流式拼装"这一形态 ----
  await page.waitForSelector(`${TOOL_ENTRY}[data-status="done"]`, { timeout: 30_000 });

  // 在 STATE_SNAPSHOT 刚到的那一刻取"高亮之前"的画面。
  // 这个时刻是**确定的**：快照之后还有两拍解说（约 1 秒），指点事件排在它们后面，
  // 所以这里一定还没高亮。
  await waitForState(page, (s) => s.sharedState !== null, undefined, 30_000);
  const ink = await countInk(page, CHART_CANVAS);
  expect(ink, '图表画布上必须有实际绘制内容').toBeGreaterThan(1000);

  // ★ 切过来了：绘图区**显示**的是图表层。
  //   注意工艺图那一层仍然在（只是 `hidden`）—— 它是主视图，设计上永不销毁，
  //   所以切回来是"显示"而不是"重建"（这一条在 diagram.spec.ts 里单独钉）。
  const stage = await readStage(page);
  expect(stage.active).toBe('chart');
  expect(stage.layers.sort()).toEqual(['chart', 'diagram']);
  expect(stage.builds.diagram).toBe(1);
  await expect(page.locator(DIAGRAM_CANVAS)).toBeHidden();
  await expect(page.locator(CHART_CANVAS)).toBeVisible();

  const beforePointAt = await canvasSignature(page, CHART_CANVAS);

  // 拼装完成后原文被收起，换成一句"分片流式传完"的说明
  await expect(page.locator(`${TOOL_ENTRY} .hint`)).toContainText('分片流式传完');
  await expect(page.locator(`${TOOL_ENTRY} .args`)).toBeHidden();

  // ---- 「指着讲」：run 结束前后画布内容应当不同（高亮/提示框被画上去了） ----
  await waitSettled(page, before.eventCount + 1);
  const afterPointAt = await canvasSignature(page, CHART_CANVAS);
  expect(afterPointAt, '指着讲应当改变画面').not.toBe(beforePointAt);

  // ---- 协议层状态 ----
  const state = await readState(page);
  expect(state.status).toBe('idle');
  expect(state.sharedState.chart.kind).toBe('bar');
  expect(state.pointAt, '指点事件应当被归约进状态').toEqual({ value: '3月', seq: 1 });
  // 一条用户消息 + 一句开场 + 两拍解说，加一条工具条目
  expect(state.items.filter((i) => i.kind === 'text')).toHaveLength(4);
  expect(state.items.filter((i) => i.kind === 'tool')).toHaveLength(1);
  expect(state.eventCount).toBeGreaterThan(20);

  // ---- DOM 上的呈现 ----
  await expect(page.locator('#meta')).toContainText('空闲');
  await expect(page.locator(`${TOOL_ENTRY} .card-head .title`)).toHaveText('render_chart');
  await expect(page.locator('.msg.assistant').last()).toContainText('尖峰');

  expect(errors, `页面不该有错误：\n${errors.join('\n')}`).toEqual([]);
});

test('兜底剧本：不画图，只回文字（绘图区保持原样）', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const state = await useChip(page, '今天天气怎么样');

  await expect(page.locator(TOOL_ENTRY)).toHaveCount(0);
  expect(state.sharedState).toBeNull();
  // 本地乐观插入的用户消息 + Agent 的回复
  expect(state.items).toHaveLength(2);
  expect(state.items[1].text).toContain('今天天气怎么样');

  // ★ "不画图"不等于"把绘图区清空" —— 刚才那张工艺图还在，只是没有新的图层被挂上
  const stage = await readStage(page);
  expect(stage.active).toBe('diagram');
  expect(stage.builds.diagram).toBe(1);
  expect(errors).toEqual([]);
});

test('连续两轮对话共用同一个 thread，条目各自独立', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  const first = await useChip(page, '看看各渠道的月度销量');
  const second = await useChip(page, '看一下实时吞吐量');

  expect(second.threadId).toBe(first.threadId);
  expect(second.runId).not.toBe(first.runId);
  // 两条工具条目各管各的，时间线是追加的。
  // （这一条曾经红过：id 里没带 runId，第二轮又发出 tc_1，把第一轮的条目顶掉了。）
  expect(second.items.filter((i) => i.kind === 'tool')).toHaveLength(2);
  await expect(page.locator(TOOL_ENTRY)).toHaveCount(2);

  // 两条条目都指向同一个绘图区图层 —— 第二个图表是**改**上去的，不是新起一块画布
  const stage = await readStage(page);
  expect(stage.builds.chart).toBe(1);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('打字追问也能触发（对话入口没被图交互顶掉）', async ({ page }) => {
  await page.goto('/');
  await useChip(page, '看看各渠道的月度销量');

  const state = await settleAfter(page, async () => {
    await page.fill('#input', '换个说法再看看');
    await page.click('#send');
  });

  expect(state.items.filter((i) => i.kind === 'tool')).toHaveLength(1);
  await expect(page.locator('.msg.user').last()).toContainText('换个说法');
});
