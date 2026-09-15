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
 * 表单要**排到内容宽度**：既不缩成左边一小块，也不被拉满整张卡片。
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
 * 而 `maxWidth` 这一半同样重要：把 896 全铺满不是"排满了"，是难看 ——
 * 一行 896 宽的输入框没人读得过来。
 */
test('表单排到内容宽度：不缩成一小块，也不拉满整张卡片', async ({ page }) => {
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

  // ---- 内容要**两边都判**：既不能缩成一小块，也不能拉满整张卡片 ----
  //
  // 只判下界是不够的：`countInk` / "占画布的 x%" 这类单边判据对
  // "把 896 全铺满"照样成立 —— 那也不是"排满了"，是难看（一行文本没人读得过来）。
  // 所以这里刻意**不写死 DSL 的 640**，只表达意图："比卡片明显窄，也比一小块明显宽"。
  const bounds = await inkBounds(page, FORM_CANVAS);
  expect(bounds, '表单画布上应当有内容').not.toBeNull();
  expect(
    bounds!.right,
    `着墨右沿只有 ${bounds!.right.toFixed(0)}px（画布 ${canvas.css.toFixed(0)}px）—— 缩成一小块了`
  ).toBeGreaterThan(500);
  expect(
    bounds!.right,
    `着墨右沿 ${bounds!.right.toFixed(0)}px 贴着画布右沿 ${canvas.css.toFixed(0)}px —— 表单被拉满了整张卡片`
  ).toBeLessThan(canvas.css - 100);
  // 左边不该空一片
  expect(bounds!.left, `左侧空了 ${bounds!.left.toFixed(0)}px`).toBeLessThan(canvas.css * 0.05);
});

/**
 * 容器变宽时表单要**跟着重新对齐**，不能只改画布尺寸。
 *
 * 这是 `setWidth()` 那条路径单独的回归：画布 `resize` 已经由引擎管了，
 * 但"表单内容多宽"是另一件事 —— 少了它，画布宽了、表单还是原来那么宽，
 * 右边照样空出一片。
 *
 * **为什么要从窄到宽，而不是从宽到窄**：缩窄时表单会被画布**裁掉**，
 * 像素上"表单跟着缩了"和"表单没缩但被裁了"长得一模一样（都是着墨到右沿）——
 * 那种用例看着在测，其实测不出来。放大的方向没有裁剪掩盖，才是可判的。
 * （实测：1440 卡片 896 / 表单 640；820 卡片 736 / 表单 640；700 卡片 616 / 表单 616。）
 */
test('窗口变宽后表单跟着重新对齐（不只是画布变宽）', async ({ page }) => {
  // 先在窄视口下打开并触发表单卡：这时容器只给得起 ~500px
  await page.setViewportSize({ width: 600, height: 900 });
  await page.goto('/');
  await openFormCard(page);

  const narrow = await inkBounds(page, FORM_CANVAS);
  expect(narrow).not.toBeNull();
  // 窄的时候表单就排到容器宽度（没到 DSL 的 640 上限）
  expect(narrow!.right, '窄视口下表单应当排到约 500px').toBeLessThan(600);
  expect(narrow!.widthRatio).toBeGreaterThan(0.9);

  // 放大到卡片能给出 896 —— 表单要跟到内容上限 640，而不是停在那 500
  await page.setViewportSize({ width: 1440, height: 900 });

  // `window.resize` → `view.resizeAll()` 是同步的，但布局/重绘要等一帧，所以轮询而不是赌
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

  // 停在内容上限 640，不是铺满整张 896 的卡片
  expect(wide).toBeGreaterThan(700);
  expect(bounds!.right).toBeGreaterThan(Math.min(wide, 640) - 8);
  expect(bounds!.right).toBeLessThanOrEqual(Math.min(wide, 640) + 8);
});
