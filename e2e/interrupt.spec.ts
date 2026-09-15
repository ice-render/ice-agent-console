import { expect, test } from '@playwright/test';
import {
  clickFormSubmit,
  collectErrors,
  countInk,
  fillForm,
  FORM_CANVAS,
  inkBounds,
  readState,
  settleAfter,
  useChip,
  waitForState,
  WIDGET_CANVAS,
} from './helpers';

/**
 * 人机回环：**中断 → 填表 → resume**。
 *
 * 这是 AG-UI 里此前完全没做的那一块，也是把 `ice-web-components-dsl` 接进来的理由。
 *
 * 协议要点（这几个不是我们自定的，是从 `@ag-ui/core` 的 schema 里问出来的）：
 *  - 中断**也是** `RUN_FINISHED`，只是带 `outcome.type === 'interrupt'`；
 *  - `interrupt` 的形状是 `{ id, reason, message? }`，`id` 与 `reason` 必填；
 *  - 恢复方式**不是"接着跑"**，而是开一个新 run，在 `RunAgentInput.resume` 里
 *    带 `{ interruptId, status: 'resolved' | 'cancelled', payload }`。
 *
 * 所以这个 spec 真正要证明的是：**这套语义在前端被正确地实现了一遍** ——
 * 中断进 `waiting`、答复走 `resume`、答复完中断被清掉。
 */
test('「要下发指令」触发中断：出表单卡、状态进 waiting', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  const before = await readState(page);
  // 注意：这里**不能用 settleAfter** —— 它等的是 `idle`，而中断轮结束在 `waiting`，
  // 永远等不到。中断要单独等一个状态。
  await page.locator('.chip', { hasText: '要下发指令' }).first().click();
  await waitForState(page, (s, min) => s.status === 'waiting' && s.eventCount > min, before.eventCount);
  const state = await readState(page);

  // 状态不是 idle 而是 waiting —— 用户还没填表
  expect(state.status).toBe('waiting');
  expect(state.interrupt).toMatchObject({ id: 'confirm-params' });
  expect(state.interrupt!.reason).toBeTruthy();

  // 卡片是**表单卡**，不是图表卡
  const tools = state.items.filter((i) => i.kind === 'tool') as any[];
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe('collect_input');
  expect(tools[0].dsl.kind, '参数应当是表单 DSL').toBe('form');

  // 表单卡不该显示图表或控件条（三者互斥）。
  //
  // 注意用 `toBeHidden` 而不是 `toHaveCount(0)`：卡片骨架在构造时就一并建了
  // chart / form / widget 三个容器，只有用到那个才取消隐藏。所以 DOM 里"有几个 canvas"
  // 不代表"显示的是哪种形态"，要按**可见性**断言。
  await expect(page.locator('.card')).toHaveCount(1);
  await expect(page.locator(FORM_CANVAS)).toBeVisible();
  await expect(page.locator('.card .chart-wrap canvas')).toBeHidden();
  // 控件层则是**惰性创建**的，表单卡根本不会建它
  await expect(page.locator(WIDGET_CANVAS)).toHaveCount(0);

  // 表单**真的画出来了**
  expect(await countInk(page, FORM_CANVAS)).toBeGreaterThan(3000);

  // 状态栏显示"等待"而不是"空闲"
  await expect(page.locator('#meta')).toContainText('等待');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('必填没填时点提交被拦住：不进已提交、仍在 waiting', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  const before = await readState(page);
  await page.locator('.chip', { hasText: '要下发指令' }).first().click();
  await waitForState(page, (s, min) => s.status === 'waiting' && s.eventCount > min, before.eventCount);

  // 真实点中画布上的提交按钮（泵站是必填，还没填）
  await clickFormSubmit(page);
  await page.waitForTimeout(300);

  const after = await readState(page);
  expect(after.status, '校验没过就不该离开 waiting').toBe('waiting');
  expect(after.interrupt, '中断还在，因为还没答复').not.toBeNull();
  expect((after.items.filter((i) => i.kind === 'tool') as any[])[0].submitted).toBeUndefined();
  // 没有发生新一轮 run
  await expect(page.locator('.card')).toHaveCount(1);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('填全后真实点提交：带 resume 开新 run，agent 读得到值', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  const before = await readState(page);
  await page.locator('.chip', { hasText: '要下发指令' }).first().click();
  await waitForState(page, (s, min) => s.status === 'waiting' && s.eventCount > min, before.eventCount);

  const during = await readState(page);

  const after = await settleAfter(page, async () => {
    await fillForm(page, { station: 'pump-2', mode: 'manual', flow: 1200, note: '例检' });
    await clickFormSubmit(page);
    await expect(page.locator('.msg.user').last()).toContainText('已提交表单', { timeout: 5000 });
  });

  // ---- 中断被答复了 ----
  expect(after.interrupt, '答复完中断要被清掉').toBeNull();
  expect(after.status).toBe('idle');
  expect(after.runId).not.toBe(during.runId);

  // ---- 卡片变成"已提交"终态 ----
  const tool = (after.items.filter((i) => i.kind === 'tool') as any[])[0];
  expect(tool.submitted).toBe(true);
  await expect(page.locator('.card .card-head .status')).toHaveText('已提交');

  // ---- agent 确实读到了 resume 里的 payload ----
  const reply = (after.items.filter((i) => i.kind === 'text') as any[]).slice(-1)[0];
  expect(reply.text).toContain('pump-2');
  expect(reply.text).toContain('manual');
  expect(reply.text).toContain('1200');
  expect(reply.text, '要说明这些值是走 resume 回来的').toContain('resume');

  // ---- 这一轮不该再产生新的卡片或新的中断 ----
  await expect(page.locator('.card')).toHaveCount(1);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('中断卡与图表卡能在同一条时间线里共存', async ({ page }) => {
  await page.goto('/');

  await useChip(page, '看看各渠道的月度销量');
  await expect(page.locator('.card')).toHaveCount(1);

  const before = await readState(page);
  await page.locator('.chip', { hasText: '要下发指令' }).first().click();
  await waitForState(page, (s, min) => s.status === 'waiting' && s.eventCount > min, before.eventCount);

  // 两张卡：图表在前、表单在后，各自渲染各自的形态（按可见性断言，理由同上）
  await expect(page.locator('.card')).toHaveCount(2);
  await expect(page.locator('.card .chart-wrap canvas:visible')).toHaveCount(1);
  await expect(page.locator(`${FORM_CANVAS}:visible`)).toHaveCount(1);

  // 时间线仍是追加的，两张卡都在
  const state = await readState(page);
  const names = (state.items.filter((i) => i.kind === 'tool') as any[]).map((i) => i.name);
  expect(names).toEqual(['render_chart', 'collect_input']);
});

/** 触发中断拿到表单卡，停在 `waiting`。 */
async function openFormCard(page: import('@playwright/test').Page): Promise<void> {
  const before = await readState(page);
  await page.locator('.chip', { hasText: '要下发指令' }).first().click();
  await waitForState(page, (s, min) => s.status === 'waiting' && s.eventCount > min, before.eventCount);
}

/**
 * 表单要**撑满**卡片宽度。
 *
 * 这一条是实测缺陷的回归：宿主容器 896 宽时，表单只在左边画了 229px，
 * **右边空掉 667px（74%）**。注意 `countInk` 抓不到这种缺陷 ——
 * 着墨量照样几千，"画出来了"是成立的；只有按**排布**判才看得见。
 *
 * 根因在 DSL 层，不在渲染器：
 * 宽度在 ICE 里是每个组件自己的属性，没有"父级拉满"的自动传导 ——
 * `ICEForm` 的 `align:'stretch'` 只拉 `ICEFormItem`，**不拉控件**；
 * 于是每个控件落到各自的出厂默认（ICETextField 200、ICEInputNumber 140…），
 * 同一张表单里几个控件还互不相同。
 */
test('表单撑满卡片宽度，右侧不留大片空白', async ({ page }) => {
  await page.goto('/');
  await openFormCard(page);

  // ---- 画布本身先是"容器多宽就是多宽"（走引擎的 fitCanvasToDisplaySize）----
  const canvas = await page.evaluate((sel) => {
    const c = document.querySelector(sel) as HTMLCanvasElement;
    const box = c.getBoundingClientRect();
    return { backing: c.width, css: box.width, dpr: window.devicePixelRatio };
  }, FORM_CANVAS);
  expect(canvas.css).toBeGreaterThan(700);
  // backing store = 逻辑宽 × dpr（**不是**把逻辑宽取整后再乘）
  expect(canvas.backing).toBe(Math.round(canvas.css * canvas.dpr));

  // ---- 内容要几乎铺满（修复前 widthRatio ≈ 0.26）----
  const bounds = await inkBounds(page, FORM_CANVAS);
  expect(bounds, '表单画布上应当有内容').not.toBeNull();
  expect(
    bounds!.widthRatio,
    `着墨只占画布宽的 ${(bounds!.widthRatio * 100).toFixed(1)}%，右侧空 ${(canvas.css - bounds!.right).toFixed(0)}px`
  ).toBeGreaterThan(0.9);
  // 左边也不该反过来空一片
  expect(bounds!.left, `左侧空了 ${bounds!.left.toFixed(0)}px`).toBeLessThan(canvas.css * 0.05);
});

/**
 * 窗口变窄时要**重新对齐内容**，不能只改画布尺寸。
 *
 * 这是 `setWidth()` 那条路径单独的回归：画布 `resize` 已经由引擎管了，
 * 但"表单内容多宽"是另一件事 —— 少了它，缩窗口之后画布窄了、表单还是原来那么宽，
 * 右边被裁掉；或者反过来，表单没跟着缩，右侧又空出来。
 */
test('窗口变窄后表单跟着重新对齐（不只是画布变窄）', async ({ page }) => {
  await page.goto('/');
  await openFormCard(page);

  const wide = await inkBounds(page, FORM_CANVAS);
  expect(wide).not.toBeNull();
  expect(wide!.widthRatio).toBeGreaterThan(0.9);

  await page.setViewportSize({ width: 820, height: 900 });

  // `window.resize` → `view.resizeAll()` 是同步的，但布局/重绘要等一帧，所以轮询而不是赌
  await expect
    .poll(async () => (await inkBounds(page, FORM_CANVAS))?.right ?? Infinity, {
      message: '缩窄之后表单没有跟着变窄',
      timeout: 5000,
    })
    .toBeLessThan(wide!.right - 100);

  // 变窄之后仍然是"铺满新宽度"，而不是"缩了一点点然后右边又空出来"
  const narrow = await inkBounds(page, FORM_CANVAS);
  expect(
    narrow!.widthRatio,
    `缩窄后着墨只占 ${(narrow!.widthRatio * 100).toFixed(1)}%`
  ).toBeGreaterThan(0.9);
});
