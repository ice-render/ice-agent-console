import { expect, test } from '@playwright/test';
import {
  CHART_CANVAS,
  FORM_CANVAS,
  TOOL_ENTRY,
  WIDGET_CANVAS,
  clickFormSubmit,
  collectErrors,
  countInk,
  fillForm,
  inkBounds,
  readStage,
  readState,
  settleAfter,
  useChip,
  waitForState,
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
test('「要下发指令」触发中断：绘图区切成表单、状态进 waiting', async ({ page }) => {
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

  // 条目是**表单**那次调用，不是图表
  const tools = state.items.filter((i) => i.kind === 'tool') as any[];
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe('collect_input');
  expect(tools[0].dsl.kind, '参数应当是表单 DSL').toBe('form');

  // 绘图区切到了表单层（原来是工艺图）
  const stage = await readStage(page);
  expect(stage.active).toBe('form');
  expect(stage.builds.form).toBe(1);

  // 一次只有一层**在显示**。图表 / 表单这两个按需图层互斥（切过来时把对方收掉），
  // 而工艺图那一层仍然在 —— 它是主视图，设计上永不销毁，只是 `hidden`。
  await expect(page.locator(FORM_CANVAS)).toBeVisible();
  await expect(page.locator(CHART_CANVAS)).toHaveCount(0);
  await expect(page.locator(WIDGET_CANVAS)).toHaveCount(0);
  await expect(page.locator('.stage-layer[data-kind="diagram"] canvas')).toBeHidden();
  expect(stage.layers.sort()).toEqual(['diagram', 'form']);

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
  // 没有发生新一轮 run，绘图区也没换
  await expect(page.locator(TOOL_ENTRY)).toHaveCount(1);
  expect((await readStage(page)).active).toBe('form');
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

  // ---- 条目变成"已提交"终态 ----
  const tool = (after.items.filter((i) => i.kind === 'tool') as any[])[0];
  expect(tool.submitted).toBe(true);
  await expect(page.locator(`${TOOL_ENTRY} .card-head .status`)).toHaveText('已提交');

  // ---- agent 确实读到了 resume 里的 payload ----
  const reply = (after.items.filter((i) => i.kind === 'text') as any[]).slice(-1)[0];
  expect(reply.text).toContain('pump-2');
  expect(reply.text).toContain('manual');
  expect(reply.text).toContain('1200');
  expect(reply.text, '要说明这些值是走 resume 回来的').toContain('resume');

  // ---- 这一轮不该再产生新的条目、也不该换图层 ----
  await expect(page.locator(TOOL_ENTRY)).toHaveCount(1);
  expect((await readStage(page)).active, '应答不该动绘图区').toBe('form');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('图表与表单能在同一条时间线里各留一条条目（绘图区只显示后者）', async ({ page }) => {
  await page.goto('/');

  await useChip(page, '看看各渠道的月度销量');
  await expect(page.locator(TOOL_ENTRY)).toHaveCount(1);
  expect((await readStage(page)).builds.chart).toBe(1);

  const before = await readState(page);
  await page.locator('.chip', { hasText: '要下发指令' }).first().click();
  await waitForState(page, (s, min) => s.status === 'waiting' && s.eventCount > min, before.eventCount);

  // 时间线是追加的：**两条条目**都在，按顺序是图表在前、表单在后
  const state = await readState(page);
  const names = (state.items.filter((i) => i.kind === 'tool') as any[]).map((i) => i.name);
  expect(names).toEqual(['render_chart', 'collect_input']);
  await expect(page.locator(TOOL_ENTRY)).toHaveCount(2);

  // ★ 但绘图区**只显示后者**：表单顶上来了，图表那一层被**收掉** ——
  //   这是布局反转最实质的一处差别（旧结构里两张卡片各留一块画布同时活着）。
  //   工艺图那一层保留（主视图永不销毁），所以画布总数是"工艺图 1 + 表单 1 = 2"。
  const stage = await readStage(page);
  expect(stage.active).toBe('form');
  expect(stage.layers.sort()).toEqual(['diagram', 'form']);
  expect(stage.builds.chart, '图表图层被收掉了（没有堆积）').toBe(1);
  expect(await page.locator(CHART_CANVAS).count()).toBe(0);
  expect(await page.locator('#stage canvas').count()).toBe(2);

  // 「哪一条在绘图区上」这件事在对话里看得见
  await expect(page.locator(`${TOOL_ENTRY}[data-active="true"]`)).toHaveCount(1);
  await expect(page.locator(`${TOOL_ENTRY}[data-active="true"]`)).toHaveAttribute('data-tool', 'collect_input');
});

/** 触发中断拿到表单，停在 `waiting`。 */
async function openForm(page: import('@playwright/test').Page): Promise<void> {
  const before = await readState(page);
  await page.locator('.chip', { hasText: '要下发指令' }).first().click();
  await waitForState(page, (s, min) => s.status === 'waiting' && s.eventCount > min, before.eventCount);
}

/**
 * 表单要**排到内容宽度**：既不缩成左边一小块，也不被拉满整块面板。
 *
 * 这一条是实测缺陷的回归：宿主容器 896 宽时，表单只在左边画了 229px，
 * **右边空掉 667px（74%）**。注意 `countInk` 抓不到这种缺陷 ——
 * 着墨量照样几千，"画出来了"是成立的；只有按**排布**判才看得见。
 *
 * 根因在 DSL 层，不在渲染器：
 * 宽度在 ICE 里是每个组件自己的属性，没有"父级拉满"的自动传导 ——
 * `ICEForm` 的 `align:'stretch'` 只拉 `ICEFormItem`，**不拉控件**；
 * 于是每个控件落到各自的出厂默认（ICETextField 200、ICEInputNumber 140…），
 * 同一张表单里几个控件还互不相同。修法是 DSL 按类型给意图级默认宽度 + 一个 `maxWidth`。
 *
 * 而 `maxWidth` 这一半同样重要：把整块面板全铺满不是"排满了"，是难看 ——
 * 一行 720 宽的输入框没人读得过来。所以**面板刻意比 DSL 的 640 上限宽一点**，
 * 两个意图在画布上才是两件可分辨的事。
 */
test('表单排到内容宽度：不缩成一小块，也不拉满整块面板', async ({ page }) => {
  await page.goto('/');
  await openForm(page);

  // ---- 画布本身先是"面板内容盒多宽就是多宽"（走引擎的 fitCanvasToDisplaySize）----
  const canvas = await page.evaluate((sel) => {
    const c = document.querySelector(sel) as HTMLCanvasElement;
    const box = c.getBoundingClientRect();
    return { backing: c.width, css: box.width, dpr: window.devicePixelRatio };
  }, FORM_CANVAS);
  expect(canvas.css).toBeGreaterThan(600);
  // backing store = 逻辑宽 × dpr（**不是**把逻辑宽取整后再乘）
  expect(canvas.backing).toBe(Math.round(canvas.css * canvas.dpr));

  // ---- 内容要**两边都判**：既不能缩成一小块，也不能拉满面板 ----
  //
  // 只判下界是不够的：`countInk` / "占画布的 x%" 这类单边判据对
  // "把面板全铺满"照样成立 —— 那也不是"排满了"，是难看（一行文本没人读得过来）。
  // 所以这里刻意**不写死 DSL 的 640**，只表达意图："比面板明显窄，也比一小块明显宽"。
  const bounds = await inkBounds(page, FORM_CANVAS);
  expect(bounds, '表单画布上应当有内容').not.toBeNull();
  expect(
    bounds!.right,
    `着墨右沿只有 ${bounds!.right.toFixed(0)}px（画布 ${canvas.css.toFixed(0)}px）—— 缩成一小块了`
  ).toBeGreaterThan(500);
  expect(
    bounds!.right,
    `着墨右沿 ${bounds!.right.toFixed(0)}px 贴着画布右沿 ${canvas.css.toFixed(0)}px —— 表单被拉满了整块面板`
  ).toBeLessThan(canvas.css - 8);
  // 左边不该空一片
  expect(bounds!.left, `左侧空了 ${bounds!.left.toFixed(0)}px`).toBeLessThan(canvas.css * 0.05);
});

/**
 * 面板变宽时表单要**跟着重新对齐**，不能只改画布尺寸。
 *
 * 这是 `setWidth()` 那条路径单独的回归：画布 `resize` 已经由引擎管了，
 * 但"表单内容多宽"是另一件事 —— 少了它，画布宽了、表单还是原来那么宽，
 * 右边照样空出一片。
 *
 * **为什么要从窄到宽，而不是从宽到窄**：缩窄时表单会被画布**裁掉**，
 * 像素上"表单跟着缩了"和"表单没缩但被裁了"长得一模一样（都是着墨到右沿）——
 * 那种用例看着在测，其实测不出来。放大的方向没有裁剪掩盖，才是可判的。
 *
 * 布局反转之后"面板多宽"由两件事决定：视口宽度（浮层的 `calc(100% - 64px)`）
 * 与表单自己的宽度上限（720）。
 */
test('窗口变宽后表单跟着重新对齐（不只是画布变宽）', async ({ page }) => {
  // 先在窄视口下打开并触发表单：这时浮层只给得起 ~450px（600 - 64 边框 - 48 内边距）
  await page.setViewportSize({ width: 600, height: 900 });
  await page.goto('/');
  await openForm(page);

  const narrow = await inkBounds(page, FORM_CANVAS);
  const narrowCanvas = await page.evaluate((sel) => {
    const c = document.querySelector(sel) as HTMLCanvasElement;
    return Math.round(c.getBoundingClientRect().width);
  }, FORM_CANVAS);
  expect(narrow).not.toBeNull();
  // 窄的时候表单就排到容器宽度（没到 DSL 的 640 上限）
  expect(narrowCanvas, '窄视口下浮层只给得起不到 600 宽').toBeLessThan(600);
  expect(narrow!.widthRatio, '窄视口下表单应当排满画布').toBeGreaterThan(0.9);

  // 放大到浮层能给满 720 —— 表单要跟到内容上限 640，而不是停在那 450
  await page.setViewportSize({ width: 1440, height: 900 });

  // 尺寸跟视口走靠 `ResizeObserver`，派发与重绘要等一拍，所以轮询而不是赌
  await expect
    .poll(async () => (await inkBounds(page, FORM_CANVAS))?.right ?? 0, {
      message: '放大之后表单没有跟着变宽（少了 setWidth 就是这个症状）',
      timeout: 5000,
    })
    .toBeGreaterThan(narrow!.right + 100);

  const wide = await page.evaluate((sel) => {
    const c = document.querySelector(sel) as HTMLCanvasElement;
    return Math.round(c.getBoundingClientRect().width);
  }, FORM_CANVAS);
  const bounds = await inkBounds(page, FORM_CANVAS);

  // 停在内容上限 640，不是铺满整块 672 的画布
  expect(wide).toBeGreaterThan(600);
  expect(bounds!.right).toBeGreaterThan(Math.min(wide, 640) - 8);
  expect(bounds!.right).toBeLessThanOrEqual(Math.min(wide, 640) + 8);
});
