import { expect, test } from '@playwright/test';
import {
  CHART_CANVAS,
  DIAGRAM_CANVAS,
  TOOL_ENTRY,
  canvasSignature,
  chatScroll,
  chipLocator,
  collectErrors,
  countInk,
  readStage,
  readState,
  scrollChatTo,
  settleAfter,
  useChip,
  waitDiagramReady,
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
  await chipLocator(page, '看看各渠道的月度销量').click();

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

/**
 * ★ 快捷按钮**分组**：工艺图那组在最前，而且两组各自连续。
 *
 * 这条用例守的是"排布"而不是"有没有" —— 11 个按钮平铺也能用，但会有一个具体的坑：
 * `故意画错` 与 `故意画错工艺图` 只差三个字、作用对象完全不同（一个改图表、一个改工艺图），
 * 混在一起摆很容易点错。分组之后它们分别在两组的最后一位，中间隔着组名。
 */
test('★ 快捷按钮按"作用对象"分组：工艺图那组在最前且连续', async ({ page }) => {
  await page.goto('/');
  await waitDiagramReady(page);

  const groups = await page.evaluate(() => {
    const out: Array<{ label: string | null; chips: string[] }> = [];
    for (const el of Array.from(document.querySelectorAll('#chips > *')) as HTMLElement[]) {
      if (el.classList.contains('chip-group')) out.push({ label: el.textContent ?? '', chips: [] });
      else if (out.length) out[out.length - 1].chips.push(el.textContent ?? '');
      else out.push({ label: null, chips: [el.textContent ?? ''] });
    }
    return out;
  });

  // 两组，且**第一组是工艺图**（工艺图是整页主体，所以它排最前）
  expect(groups.map((g) => g.label)).toEqual(['工艺图', '其他']);

  const [diagram, others] = groups;
  // 第一组全是且只是"作用在工艺图上"的那几条
  expect(diagram.chips).toEqual([
    '看看污水处理工艺图',
    '把工艺图放大',
    '让图元闪烁',
    '提标改造',
    '故意画错工艺图',
  ]);
  // ★ 两个"故意画错"分属两组（这是分组最实在的收益）
  expect(others.chips).toContain('故意画错');
  expect(diagram.chips).not.toContain('故意画错');
  // 没有按钮落在任何组之外（漏了组名就会落到上一组里，这里兜一下）
  expect(others.chips.length).toBeGreaterThan(0);
});

/**
 * ★★ 文案相近的两个按钮**必须能被分开点到**，而且与排版顺序无关。
 *
 * 这一条是**实测踩响的雷**，值得单独一条：
 *
 * `故意画错` 与 `故意画错工艺图` 只差三个字，作用对象却完全不同
 * （一个修**图表**、一个修**工艺图**）。原来的取法
 * `locator('.chip', { hasText })` 是**子串**匹配 —— 它会同时命中这两个，
 * 再 `.first()` 就等价于"按 DOM 顺序取第一个"。最初能过纯粹是因为
 * "图表那个恰好排在工艺图那个前面"。
 *
 * 后来把按钮按作用对象分组（工艺图那组排最前），顺序一换就立刻踩响：
 * 点 `故意画错` 变成了点 `故意画错工艺图`，报出来的错是
 * "Cannot read properties of undefined (reading 'y')" —— 从这句根本看不出
 * 是"点错了按钮"。所以这里**正面钉住**两件事：
 * 精确匹配能选中正确的那一个，且两轮跑出来的计划类型不同。
 */
test('★ 两个「故意画错」能被分开点到（子串匹配会同时命中）', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitDiagramReady(page);

  // 精确匹配：每个文案只该命中唯一的按钮
  for (const text of ['故意画错', '故意画错工艺图', '提标改造', '看看污水处理工艺图']) {
    await expect(chipLocator(page, text), `「${text}」应当只命中一个按钮`).toHaveCount(1);
  }

  // `故意画错` → 修**图表**那一版坏 DSL（列名写错，不是隔油池）
  await useChip(page, '故意画错');
  await waitSettled(page, 1);
  const chartRepair = await page.evaluate(() => {
    const tools = (window as any).__iceAgentConsole.getState().items.filter((i: any) => i.kind === 'tool');
    return { tool: tools[0]?.name, kind: tools[0]?.dsl?.kind };
  });
  expect(chartRepair.tool).toBe('render_chart');

  // `故意画错工艺图` → 修**图**那一版（隔油池：看着合理但不在记号集里）
  await page.reload();
  await waitDiagramReady(page);
  await useChip(page, '故意画错工艺图');
  await waitSettled(page, 1);
  const diagramRepair = await page.evaluate(() => {
    const tools = (window as any).__iceAgentConsole.getState().items.filter((i: any) => i.kind === 'tool');
    return { tool: tools[0]?.name, kind: tools[0]?.dsl?.kind };
  });
  expect(diagramRepair.tool).toBe('render_diagram');
  expect(diagramRepair.kind).toBe('water-process');

  expect(errors, errors.join('\n')).toEqual([]);
});

/**
 * ★ 新消息进来时**自动滚到底部**，但用户翻上去看历史时**不许把他拽回来**。
 *
 * ## 为什么必须是"有条件的跟随"
 *
 * 无条件滚到底会让面板没法往回读：你刚往上翻两屏看前面那段解释，
 * 下一条流式文本就把你拽回底部 —— 而且流式文本每秒来十几次，根本翻不上去。
 * 所以跟随的前提是"用户本来就在底部"，他一旦自己往上滚就松手。
 *
 * ## 为什么放在 e2e（而不是单测）
 *
 * 单测那套 jest 是 `testEnvironment: 'node'`，**没有真的滚动容器** ——
 * `scrollHeight` / `scrollTop` / `clientHeight` 与 `scroll` 事件的派发时机
 * 都是浏览器的行为，用假 DOM 测出来的只是"我调了这个属性"，证明不了"真的跟住了"。
 */
test('★ 新消息自动滚到底；用户翻上去之后不拽回来，滚回底部又接上', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitDiagramReady(page);

  // 先跑一条会产出大量内容的（工艺图走查：十几拍解说 + 一条工具条目），把面板撑满
  await useChip(page, '看看污水处理工艺图');
  await waitSettled(page, 1);

  // ---- ① 跟到底部 ----
  const afterRun = await chatScroll(page);
  expect(afterRun.scrollHeight, '内容应当已经溢出，否则这条用例证明不了什么').toBeGreaterThan(
    afterRun.clientHeight
  );
  expect(afterRun.fromBottom, '新消息进来之后应当贴在底部').toBeLessThanOrEqual(8);

  // ---- ② 用户往上翻 → 再来一条新消息 → **不该**被拽回底部 ----
  await scrollChatTo(page, 0);
  const atTop = await chatScroll(page);
  expect(atTop.scrollTop).toBe(0);

  await useChip(page, '看一下实时吞吐量');
  await waitSettled(page, 1);

  const stillAtTop = await chatScroll(page);
  expect(stillAtTop.scrollTop, '用户翻上去之后，新消息不该把他拽回底部').toBeLessThanOrEqual(4);
  // 内容确实变多了（否则"没滚动"可能只是因为压根没新内容）
  expect(stillAtTop.scrollHeight).toBeGreaterThan(atTop.scrollHeight);

  // ---- ③ 滚回底部 → 再来的新消息**重新跟上** ----
  await scrollChatTo(page, 'bottom');
  await useChip(page, '看看各渠道的月度销量');
  await waitSettled(page, 1);

  const followedAgain = await chatScroll(page);
  expect(followedAgain.fromBottom, '滚回底部之后应当重新跟随').toBeLessThanOrEqual(8);

  expect(errors, errors.join('\n')).toEqual([]);
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
