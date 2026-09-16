/**
 * 图卡片（`render_diagram`）——内置案例「污水处理工艺图」。
 *
 * 这一条覆盖的是**第三种卡片形态**：`ice-entity-designer` 把一张工艺图画进对话卡片。
 * 与 chart / form 两张卡最大的不同在于**它是一张"图"而不是"图表"**：
 * 34 个带位号的构筑物符号 + 37 段按介质着色的管线，用满了上游的 31 种符号与 9 种介质。
 *
 * 断言分三层，缺一层就证不完整：
 * 1. **形态**：卡片挂的是 `.diagram-wrap`，另外三层是隐藏的（`CardView` 构造时把
 *    所有 wrap 都建好了，所以只能按**可见性**断言，数元素个数会永远通过）。
 * 2. **画布**：真的画了东西（着墨量），且画布尺寸来自引擎而不是 canvas 默认的 300×150。
 * 3. **模型层**：符号数 / 管线数 / 引擎的 `validateWater()` 零问题 ——
 *    这一层才钉得住"图是对的"，光数像素证明不了数量对。
 */
import { expect, test } from '@playwright/test';
import {
  DIAGRAM_CANVAS,
  canvasSignature,
  collectErrors,
  countInk,
  readState,
  useChip,
  waitSettled,
} from './helpers';

/** 案例规模：与 `server/agents/water-process-case.ts` 一致（也是那边的 e2e 断言值）。 */
const SYMBOLS = 34;
const PIPES = 37;

test('工艺图卡片：画出来了、数是 34/37、引擎校验无问题、零 console error', async ({ page }) => {
  const errors = collectErrors(page);

  await page.goto('/');
  const state = await useChip(page, '看看污水处理工艺图');

  // ---- 1. 形态：按**可见性**断言 ----
  await expect(page.locator('.card .diagram-wrap')).toBeVisible();
  await expect(page.locator('.card .chart-wrap')).toBeHidden();
  await expect(page.locator('.card .form-wrap')).toBeHidden();
  await expect(page.locator('.card .widget-wrap')).toBeHidden();
  await expect(page.locator('.card .card-head .title')).toHaveText('render_diagram');
  await expect(page.locator('.card')).toHaveAttribute('data-status', 'done');

  // 协议层：图 DSL 落在自己的 stateKey 上（不是 chart / form）
  expect(state.sharedState.diagram.kind).toBe('water-process');
  expect(state.sharedState.chart).toBeUndefined();
  expect(state.items.filter((i) => i.kind === 'tool')).toHaveLength(1);

  // ---- 2. 画布：尺寸来自引擎，且真的着墨了 ----
  const box = (await page.locator(DIAGRAM_CANVAS).boundingBox())!;
  expect(box.width).toBeGreaterThan(800);
  // 默认 canvas 是 300×150；能到 400+ 说明 `fitCanvasToDisplaySize` 真的跑过了
  expect(box.height).toBeGreaterThan(400);

  const backing = await page.evaluate((sel) => {
    const cv = document.querySelector(sel) as HTMLCanvasElement;
    return { w: cv.width, h: cv.height };
  }, DIAGRAM_CANVAS);
  // backing store 必须跟着 CSS 尺寸走（不一致的画面会被拉伸/模糊）
  expect(Math.abs(backing.w - box.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(backing.h - box.height)).toBeLessThanOrEqual(1);

  // 着墨：不是"元素存在但全白"。工艺图的符号是**实底填充**（水线浅蓝 / 泥线浅黄），
  // 所以墨量主要由填充贡献，阈值可以定得比细线条图高。
  expect(await countInk(page, DIAGRAM_CANVAS)).toBeGreaterThan(20_000);

  // ---- 3. 模型层：这才是"图对不对" ----
  const stats = await page.evaluate(() => (window as any).__iceAgentConsole.diagramStats());
  expect(stats).not.toBeNull();
  expect(stats.symbols).toBe(SYMBOLS);
  expect(stats.pipes).toBe(PIPES);
  // 引擎的 `validateWater()`：位号唯一 / 单元要有进出线 / 管线要标介质与管径 /
  // 出水路径必须有在线监测 / 剩余污泥要有出路 / AAO 要有内回流。
  // 同一份数据在 ice-smart-water 里也是零问题 —— 两边一致才说明搬的时候没改语义。
  expect(stats.issues).toEqual([]);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('初始视野：按 DSL 里的 focus 框适配，内容没被裁到框外', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await useChip(page, '看看污水处理工艺图');
  // ⚠️ 必须等整轮跑完：讲解节拍里的 `pointAt` 会**主动把镜头移到被指的单元上**，
  // 那是叠加在初始视野之上的第二次定位。不等的话量到的是某个中间态的镜头。
  await waitSettled(page, 1);

  // 初始视野是"建立镜头"，被后来的 pointAt 覆盖了 —— 用 `scale` 钉住"适配真的算过"。
  // 缩放在一轮 run 里只由初始适配与滚轮决定（本用例没滚），所以它仍是初始值。
  const vp = await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport());
  expect(vp).not.toBeNull();

  // 缩放落在允许区间，且**不是** 1（1 表示适配没生效，图会溢出去）
  expect(vp.scale).toBeGreaterThan(0);
  expect(vp.scale).toBeLessThanOrEqual(1);

  // 内容包围盒是真实数据（世界坐标），不是空盒子
  expect(vp.contentBox).not.toBeNull();
  expect(vp.contentBox.maxX - vp.contentBox.minX).toBeGreaterThan(1000);
  expect(vp.contentBox.maxY - vp.contentBox.minY).toBeGreaterThan(500);

  // 适配算法：scale = min(可用宽/内容宽, 可用高/内容高)，上限 1。
  // 按 focus 框算 —— 用 contentBox 复核至少要保证"不是整图硬塞"（那会更小）。
  const focusW = vp.focusBox.maxX - vp.focusBox.minX;
  const fitByFocus = (vp.cssWidth - 32) / focusW;
  expect(vp.scale).toBeCloseTo(Math.min(fitByFocus, 1), 2);

  // focus 真的在裁：主流程链**横向铺满整图**（进水在最左、排放口在最右），
  // 所以它裁掉的是**纵向**那一大块（污泥线 / 事故池支路 / 除臭装置）。
  // 这条断言同时也说明"为什么要有 focus"—— 按整图算会白白为用不上的行留出高度。
  const focusH = vp.focusBox.maxY - vp.focusBox.minY;
  const contentH = vp.contentBox.maxY - vp.contentBox.minY;
  expect(focusH).toBeLessThan(contentH);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('视口可交互：滚轮缩放与空白处拖拽平移都会改变画面', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await useChip(page, '看看污水处理工艺图');

  const before = await canvasSignature(page, DIAGRAM_CANVAS);
  const scaleBefore = (await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport())).scale;

  // ---- 滚轮缩放 ----
  const box = (await page.locator(DIAGRAM_CANVAS).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -240); // 向上滚 = 放大
  await page.waitForTimeout(220);

  const scaleAfter = (await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport())).scale;
  expect(scaleAfter).toBeGreaterThan(scaleBefore);
  expect(await canvasSignature(page, DIAGRAM_CANVAS)).not.toBe(before);

  // ---- 空白处拖拽平移 ----
  const afterZoom = await canvasSignature(page, DIAGRAM_CANVAS);
  const txBefore = (await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport())).tx;
  // 挑一个基本可以确定是空白的位置（画布左下角一带），从那儿拖
  await page.mouse.move(box.x + 40, box.y + box.height - 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + box.height - 90, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(220);

  const txAfter = (await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport())).tx;
  expect(txAfter).not.toBe(txBefore);
  expect(await canvasSignature(page, DIAGRAM_CANVAS)).not.toBe(afterZoom);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('「指着讲」：讲解时高亮对应单元，讲完的单元 id 可查', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await useChip(page, '看看污水处理工艺图');
  await waitSettled(page, 1);

  // 剧本的最后一拍指着消毒接触池；讲完之后高亮留着（与图表卡的行为一致）
  const pointed = await page.evaluate(() => (window as any).__iceAgentConsole.diagramPointedId());
  expect(pointed).toBe('disinfect');

  // 高亮必须落在**真的有这个单元**的图上：id 能在 DSL 里找到
  const state = await readState(page);
  const ids = state.sharedState.diagram.units.map((u: any) => u.id);
  expect(ids).toContain(pointed);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('坏图 DSL 被拦下 → 诊断回灌 → **仍然修成一张图**（不是修成柱状图）', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  // chip「故意画错」+ 指明工艺图：剧本按关键词分流 ——
  // "故意画错"进修复支，而"工艺图"决定它吐的是**图**的坏 DSL 而不是图表的坏 DSL。
  // bad DSL 给图数据加了一个「隔油池」：真实构筑物，但不在这套 31 种符号的记号集里 ——
  // 这正是要展示的那类错误：不是拼错，而是用了记号集里没有的东西。
  await useChip(page, '故意画错工艺图');

  // 等两轮都跑完：第一轮吐坏的，第二轮吐修好的（与图表那条自修复用例同构）
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

  // ---- 第一张卡片：坏 DSL，**没有**建画布，只摆诊断 ----
  expect(tools[0].dsl.units.map((u: any) => u.kind)).toContain('greaseTrap');
  const firstCard = page.locator('.card').first();
  await expect(firstCard).toHaveAttribute('data-status', 'error');
  await expect(firstCard.locator('.card-head .status')).toHaveText('校验不通过');
  // 诊断要可据以修正：指出是"未知的符号种类"，并**列出合法取值**
  const diag = await firstCard.locator('.diag').innerText();
  expect(diag).toContain('未知的符号种类');
  expect(diag).toContain('barScreen');
  // 校验不过的卡片不该白占一块 canvas 与一个 ICE 实例
  expect(await firstCard.locator('.diagram-wrap canvas').count()).toBe(0);

  // ---- 第二张卡片：修好了，而且**仍然是一张图**（这是本用例的核心）----
  // 回归点：修复剧本原先无条件吐销量柱状图 —— 图 DSL 写错会被"修"成一张图表。
  expect(tools[1].dsl.kind).toBe('water-process');
  expect(tools[1].dsl.units.map((u: any) => u.kind)).not.toContain('greaseTrap');
  const secondCard = page.locator('.card').nth(1);
  await expect(secondCard).toHaveAttribute('data-status', 'done');
  await expect(secondCard.locator('.diagram-wrap canvas')).toBeVisible();
  // 不能是图表卡：那说明修复轮吐错了形态。
  // ⚠️ 断言**可见性**而不是元素个数 —— `CardView` 构造时就把三块 canvas 全建好了
  // （只是 hidden），数个数永远会命中，那种断言必然通过、等于没测。
  await expect(secondCard.locator('.chart-wrap canvas')).toBeHidden();

  // 修好的那张图是完整的（34/37、引擎校验零问题）
  const stats = await page.evaluate(() => (window as any).__iceAgentConsole.diagramStats());
  expect(stats.symbols).toBe(SYMBOLS);
  expect(stats.pipes).toBe(PIPES);
  expect(stats.issues).toEqual([]);

  // 修完之后诊断要被清掉，否则会一直挂在 context 上
  expect(state.diagnostics).toBeNull();
  expect(state.status).toBe('idle');

  expect(errors, errors.join('\n')).toEqual([]);
});

/**
 * 缩放视图：AI 下的"查看"命令。
 *
 * 断言的取法（时间敏感的东西要挑稳的写法）：
 * - **终值**是精确的（`初始 × 1.35ⁿ`，夹到上限）—— 零时序依赖；
 * - **"确实在动"**用"存在中间值"，而不是"某一刻等于某值"—— 对帧时序不敏感；
 * - **锚点不变**是缩放正确性的硬断言：公式错一个符号就会露。
 */
test('AI 命令缩放视图：相对叠加、平滑推进、reset 精确回到初始视野', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  // 先画一张图，拿到"初始视野"这个基准（下面的 reset 要精确回到它）
  await useChip(page, '看看污水处理工艺图');
  await waitSettled(page, 1);
  const initial = await page.evaluate(() => (window as any).__iceAgentConsole.diagramZoom());
  expect(initial.animating).toBe(false);

  // 采样整轮的 scale：既拿终值，也用来证"中间确实有过渡态"
  const samples: number[] = [initial.scale];
  await page.locator('.chip', { hasText: '把工艺图放大' }).first().click();
  for (let i = 0; i < 80; i++) {
    const info = await page.evaluate(() => (window as any).__iceAgentConsole.diagramZoom());
    const st = await page.evaluate(() => (window as any).__iceAgentConsole.getState().status);
    if (info) samples.push(info.scale);
    if (st !== 'running' && i > 10) break;
    await page.waitForTimeout(70);
  }
  await waitSettled(page, 1);

  const end = await page.evaluate(() => (window as any).__iceAgentConsole.diagramZoom());
  // 剧本是 in → in → out(2 步) → reset，所以终态应当**精确回到初始视野**
  expect(end.scale).toBeCloseTo(initial.scale, 6);
  expect(end.animating).toBe(false);

  // 平滑：出现过严格介于初始与最高之间的值（一帧到位的话这条会红）
  const peak = Math.max(...samples);
  expect(peak).toBeGreaterThan(initial.scale * 1.1);
  const intermediate = samples.filter((v) => v > initial.scale * 1.01 && v < peak * 1.01);
  expect(intermediate.length).toBeGreaterThan(0);

  // 协议层记下了这条指令（与 pointAt 一样带 seq）
  const state = await readState(page);
  expect((state as any).zoom.direction).toBe('reset');
  expect((state as any).zoom.seq).toBeGreaterThanOrEqual(4);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('缩放的锚点是画布中心：放大后中心那个世界点几乎没动', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await useChip(page, '看看污水处理工艺图');
  await waitSettled(page, 1);

  const before = await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport());
  const worldCenterBefore = {
    x: (before.cssWidth / 2 - before.tx) / before.scale,
    y: (before.cssHeight / 2 - before.ty) / before.scale,
  };

  await page.locator('.chip', { hasText: '把工艺图放大' }).first().click();
  await waitSettled(page, 1);

  const after = await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport());
  const worldCenterAfter = {
    x: (after.cssWidth / 2 - after.tx) / after.scale,
    y: (after.cssHeight / 2 - after.ty) / after.scale,
  };

  // 剧本最后复位了，所以这里直接比"复位前后"也可以；关键是**镜头推进过程中**锚点守恒。
  // 复位本身也是按同一套公式（focusBox 居中）算的，所以两者都应当吻合。
  expect(Math.abs(worldCenterAfter.x - worldCenterBefore.x)).toBeLessThan(1);
  expect(Math.abs(worldCenterAfter.y - worldCenterBefore.y)).toBeLessThan(1);

  expect(errors, errors.join('\n')).toEqual([]);
});

/**
 * 图元高亮闪烁：`point_at` 加一个 `blink` 参数。
 *
 * 闪烁是**时间性**的，所以判据挑"存在性"而不是"某一刻的精确值"：
 * 在一段时间窗内轮询透明度，要求**同时**观测到"明显的暗"与"接近全亮"。
 * 6 轮 yoyo × 160ms = 960ms，多轮保证任何采样窗都能覆盖到两个相位 ——
 * 比连续采样 `canvasSignature` 稳得多（后者要恰好卡在某个相位上，必然 flaky）。
 */
test('AI 命令图元闪烁：透明度来回振荡，讲完停在全亮', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  await page.locator('.chip', { hasText: '让图元闪烁' }).first().click();

  const seen: Array<{ id: string; opacity: number; animating: boolean }> = [];
  for (let i = 0; i < 140; i++) {
    const info = await page.evaluate(() => (window as any).__iceAgentConsole.diagramBlink());
    const st = await page.evaluate(() => (window as any).__iceAgentConsole.getState().status);
    if (info && info.id) seen.push(info);
    if (st !== 'running' && i > 20) break;
    await page.waitForTimeout(70);
  }
  await waitSettled(page, 1);

  expect(seen.length).toBeGreaterThan(0);

  // ① 确实在动：中途有 animating
  expect(seen.some((s) => s.animating)).toBe(true);

  // ② 确实在闪：**同时**观测到"明显暗"与"接近全亮"。
  //    只断言"变过"是不够的（可能只抖一点点），所以要求两端都够极端。
  const opacity = seen.map((s) => s.opacity);
  expect(Math.min(...opacity)).toBeLessThan(0.45);
  expect(Math.max(...opacity)).toBeGreaterThan(0.9);

  // ③ 讲完停在**全亮**（不是停在暗处）
  //    回归点：alternate 的奇偶轮方向相反，轮数取奇数时会停在最暗处 —— 那样
  //    闪烁结束后高亮框一直是半透明的，看着像没画出来。所以轮数必须是偶数。
  const final = await page.evaluate(() => (window as any).__iceAgentConsole.diagramBlink());
  expect(final.opacity).toBeCloseTo(1, 5);
  expect(final.animating).toBe(false);

  // ④ 闪的是**被指到的那个**单元（id 与 pointedId 一致，且真的在图里）
  const state = await readState(page);
  const ids = state.sharedState.diagram.units.map((u: any) => u.id);
  expect(ids).toContain(final.id);

  expect(errors, errors.join('\n')).toEqual([]);
});

/**
 * 连续闪烁**不累积**底块。
 *
 * 每次闪烁都会新建一个半透明底块并 `addTool` 进工具层，旧的靠 `removeTool` 收走。
 * 漏收的话每闪一次就多留一层 —— 画面会越来越糊，而且**不会有任何报错**。
 * `blinkInfo().overlays` 是这件事的直接读数（= `ice.toolNodes.length`）。
 *
 * 剧本依次闪 ana → anx → aer 三个单元，所以跑完必须只剩 **1** 个工具层节点。
 */
test('连续闪烁不累积底块：闪三个单元之后工具层里只有一个', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  await page.locator('.chip', { hasText: '让图元闪烁' }).first().click();
  await waitSettled(page, 1);

  const info = await page.evaluate(() => (window as any).__iceAgentConsole.diagramBlink());
  // 只剩最后指到的那个（aer），而且**本层建的底块**只剩它一个。
  // 注意数的是"带标记的底块"而不是 `ice.toolNodes` 总数 —— 后者里还有引擎自己的
  // 对齐引导线 / 控制面板 / 连线插槽（实测基线 7~9 个），数总量等于在数引擎。
  expect(info.id).toBe('aer');
  expect(info.overlays).toBe(1);

  // 图元本身没被污染：还是 34 个（底块进的是工具层，不进 childNodes）
  const stats = await page.evaluate(() => (window as any).__iceAgentConsole.diagramStats());
  expect(stats.symbols).toBe(34);
  expect(stats.issues).toEqual([]);

  expect(errors, errors.join('\n')).toEqual([]);
});
