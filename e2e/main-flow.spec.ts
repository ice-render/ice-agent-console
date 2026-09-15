import { expect, test } from '@playwright/test';
import {
  canvasSignature,
  collectErrors,
  countInk,
  readState,
  settleAfter,
  useChip,
  waitForState,
  waitSettled,
} from './helpers';

/**
 * 主链路：问一句 → 文字流式 → 卡片里参数流式拼装 → 上画布 → 指着讲 → 结束。
 *
 * 一条用例把 Thread 式生成 UI 的每一段都走一遍。**注意判据不是"DOM 里有 canvas"，
 * 而是"画布上真的有墨"**——canvas 元素存在但全白是很典型的一种失败，
 * 只看元素是否存在会漏掉它。
 */
test('主链路：文字流式 → 卡片上画布 → 指着讲', async ({ page }) => {
  const errors = collectErrors(page);

  await page.goto('/');
  await expect(page.locator('.empty')).toBeVisible();

  const before = await readState(page);
  await page.locator('.chip', { hasText: '看看各渠道的月度销量' }).first().click();

  // ---- 文字是流式的：跟着归约状态采样，长度应当出现过多个值 ----
  // 直接读状态而不是读第一个 `.bubble`——第一个气泡是本地插入的用户消息，
  // 它一开始就是完整文本，拿它采样永远看不到"逐段到达"。
  const assistantLengths = new Set<number>();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const snapshot = await readState(page);
    const joined = snapshot.items
      .filter((i) => i.kind === 'text' && i.text !== undefined)
      .map((i) => i.text!.length)
      .join(',');
    assistantLengths.add(joined.length);
    if (snapshot.status === 'idle' && snapshot.eventCount > before.eventCount) break;
    await page.waitForTimeout(25);
  }
  expect(assistantLengths.size, '文字应当逐段到达，而不是一次到位').toBeGreaterThan(1);

  // ---- 卡片出现，参数先经历"流式拼装"这一形态 ----
  await page.waitForSelector('.card[data-status="done"]', { timeout: 30_000 });

  // 在 STATE_SNAPSHOT 刚到的那一刻取"高亮之前"的画面。
  // 这个时刻是**确定的**：快照之后还有两拍解说，指点事件排在它们后面，
  // 所以这里一定还没高亮。反过来，如果在"卡片 done"之后就取，
  // 取到的可能已经是高亮之后了——第一版就是这么红的。
  await waitForState(page, (s) => s.sharedState !== null, undefined, 30_000);
  const ink = await countInk(page);
  expect(ink, '画布上必须有实际绘制内容').toBeGreaterThan(1000);
  const beforePointAt = await canvasSignature(page);

  // 拼装完成后原文被收起，换成一句"分片流式传完"的说明
  await expect(page.locator('.card .hint')).toContainText('分片流式传完');
  await expect(page.locator('.card .args')).toBeHidden();

  // ---- 「指着讲」：run 结束前后画布内容应当不同（高亮/提示框被画上去了） ----
  await waitSettled(page, before.eventCount + 1);
  const afterPointAt = await canvasSignature(page);
  expect(afterPointAt, '指着讲应当改变画面').not.toBe(beforePointAt);

  // ---- 协议层状态 ----
  const state = await readState(page);
  expect(state.status).toBe('idle');
  expect(state.sharedState.chart.kind).toBe('bar');
  expect(state.pointAt, '指点事件应当被归约进状态').toEqual({ value: '3月', seq: 1 });
  // 一条用户消息 + 一句开场 + 两拍解说，加一张卡片
  expect(state.items.filter((i) => i.kind === 'text')).toHaveLength(4);
  expect(state.items.filter((i) => i.kind === 'tool')).toHaveLength(1);
  expect(state.eventCount).toBeGreaterThan(20);

  // ---- DOM 上的呈现 ----
  await expect(page.locator('#meta')).toContainText('空闲');
  await expect(page.locator('.card .card-head .title')).toHaveText('render_chart');
  await expect(page.locator('.msg.assistant').last()).toContainText('尖峰');

  expect(errors, `页面不该有错误：\n${errors.join('\n')}`).toEqual([]);
});

test('兜底剧本：不画图，只回文字', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const state = await useChip(page, '今天天气怎么样');

  await expect(page.locator('.card')).toHaveCount(0);
  expect(state.sharedState).toBeNull();
  // 本地乐观插入的用户消息 + Agent 的回复
  expect(state.items).toHaveLength(2);
  expect(state.items[1].text).toContain('今天天气怎么样');
  expect(errors).toEqual([]);
});

test('连续两轮对话共用同一个 thread，卡片各自独立', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  const first = await useChip(page, '看看各渠道的月度销量');
  const second = await useChip(page, '看一下实时吞吐量');

  expect(second.threadId).toBe(first.threadId);
  expect(second.runId).not.toBe(first.runId);
  // 两张卡片各管各的，时间线是追加的。
  // （这一条曾经红过：id 里没带 runId，第二轮又发出 tc_1，把第一轮的卡片顶掉了。）
  expect(second.items.filter((i) => i.kind === 'tool')).toHaveLength(2);
  await expect(page.locator('.card')).toHaveCount(2);
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
