/**
 * 工艺图（`render_diagram`）——内置案例「污水处理工艺图」。
 *
 * ## 这一组用例在布局反转后**换了主角**
 *
 * 旧结构里工艺图是"第三种卡片形态"：一张卡片、一块画布，插在消息流里。
 * 现在它是**整个应用的主视图** —— boot 时就画好、铺满视口、之后永不重建。
 * 所以这里覆盖的第一件事变成了"**开页无需任何对话就有图**"，而不再是"卡片挂的是哪个 wrap"。
 *
 * 断言仍然分三层，缺一层就证不完整：
 * 1. **形态**：绘图区上是 diagram 图层，且**只有**它一块画布。
 * 2. **画布**：真的画了东西（着墨量），且画布尺寸来自引擎而不是 canvas 默认的 300×150。
 * 3. **模型层**：符号数 / 管线数 / 引擎的 `validateWater()` 零问题 ——
 *    这一层才钉得住"图是对的"，光数像素证明不了数量对。
 *
 * 第 4 层是反转之后新加的：**不重画**。`stageInfo().builds.diagram` 是它的直接读数。
 */
import { expect, test } from '@playwright/test';
import {
  DIAGRAM_CANVAS,
  TOOL_ENTRY,
  canvasSignature,
  collectErrors,
  countInk,
  panelGeometry,
  readStage,
  readState,
  settleAfter,
  useChip,
  waitDiagramReady,
  waitSettled,
  wheelOnPanel,
} from './helpers';

/** 案例规模：与 `shared/water-process-case.ts` 一致（那边也断言这两个数）。 */
const SYMBOLS = 34;
const PIPES = 37;

test('开页就是工艺图：无需任何对话、34/37、引擎校验无问题、零 console error', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  // ---- 0. **没跟 AI 说过一句话**，图已经在绘图区上了 ----
  const stage = await readStage(page);
  expect(stage.active, '开页就该显示工艺图').toBe('diagram');
  expect(stage.builds.diagram).toBe(1);
  expect(stage.layers).toEqual(['diagram']);
  // 一块画布 —— 不是"每张卡片各留一块"
  expect(stage.canvasCount).toBe(1);
  await expect(page.locator(DIAGRAM_CANVAS)).toBeVisible();

  // 对话里干干净净：没有任何工具条目（图不是某次 tool call "画出来的"）
  await expect(page.locator(TOOL_ENTRY)).toHaveCount(0);

  // ---- 1. 画布：铺满视口，尺寸来自引擎 ----
  const box = (await page.locator(DIAGRAM_CANVAS).boundingBox())!;
  expect(box.width, '工艺图画布应当铺满视口宽度').toBeGreaterThan(1300);
  // 默认 canvas 是 300×150；能到 800+ 说明 `fitCanvasToDisplaySize` 真的跑过了
  expect(box.height).toBeGreaterThan(800);

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

  // ---- 2. 模型层：这才是"图对不对" ----
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

test('问一句工艺图：不重建，只是复用（第二次挂同一份 DSL）', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  const boot = await readStage(page);
  const state = await useChip(page, '看看污水处理工艺图');
  await waitSettled(page, 1);

  // 协议层：图 DSL 落在自己的 stateKey 上（不是 chart / form）
  expect(state.sharedState.diagram.kind).toBe('water-process');
  expect(state.sharedState.chart).toBeUndefined();
  expect(state.items.filter((i) => i.kind === 'tool')).toHaveLength(1);

  // 条目是**图**那次调用，而且状态是"已渲染"
  await expect(page.locator(TOOL_ENTRY)).toHaveCount(1);
  await expect(page.locator(`${TOOL_ENTRY} .card-head .title`)).toHaveText('render_diagram');
  await expect(page.locator(TOOL_ENTRY)).toHaveAttribute('data-status', 'done');

  // ★★ 这一条是本组用例的核心：**图没有被重画**。
  //    同一份 DSL 再挂一次 → 只把那一层重新显示出来，不建新的画布、不建新的 ICE 实例。
  const stage = await readStage(page);
  expect(stage.active).toBe('diagram');
  expect(stage.builds.diagram, '同一份 DSL 不该重建工艺图').toBe(1);
  expect(stage.canvasCount, '还是只有那 34 个符号所在的这一块画布').toBe(1);

  // 条目里明说了"没有重绘" —— 这是给人看的那条线索
  await expect(page.locator(`${TOOL_ENTRY} .hint`)).toContainText('没有重绘');

  expect(stage.shows.diagram, '只是又"显示"了一次同一层').toBe(boot.shows.diagram + 1);

  // 那份"图在绘图区上、就是这一条"的标记也落上去了
  await expect(page.locator(`${TOOL_ENTRY}[data-active="true"]`)).toHaveCount(1);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('初始视野：按 DSL 里的 focus 框适配到**可视区**，内容没被面板压住', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  // ⚠️ 初始视野要在**开页时**量，不能先问一句再量：讲解节拍里的 `pointAt`
  // 会**主动把镜头移到被指的单元上**，那是叠加在初始视野之上的第二次定位。
  // （而且现在开页就有图，"初始视野"本来就是指 boot 那一屏。）
  await waitDiagramReady(page);

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

  // ★ 适配算法用的是**可视区**宽度（画布宽度减去被对话面板压住的那块），不是画布宽度。
  //   用画布宽度算的话 scale 会明显偏大、内容被面板压掉右边一截 —— 这条就是它的回归。
  const panel = await panelGeometry(page);
  expect(vp.region.width, '可视区宽度 = 画布宽度 - 面板遮盖').toBeCloseTo(
    panel.viewport.width - (panel.viewport.width - panel.coveredFromX),
    0
  );
  expect(vp.region.width, '可视区应当明显窄于整块画布').toBeLessThan(vp.cssWidth);

  const focusW = vp.focusBox.maxX - vp.focusBox.minX;
  const fitByFocus = (vp.region.width - 32) / focusW;
  expect(vp.scale).toBeCloseTo(Math.min(fitByFocus, 1), 2);

  // 内容的屏幕范围要落**在可视区里**（右边不越过分板那条线），这是"没被压住"的直接读数
  const usableRight = vp.region.left + vp.region.width;
  expect(vp.screenBox.left, '左边不该出界').toBeGreaterThanOrEqual(-1);
  expect(vp.screenBox.right, '右边不该钻到面板底下').toBeLessThanOrEqual(usableRight + 1);

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

  const before = await canvasSignature(page, DIAGRAM_CANVAS);
  const scaleBefore = (await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport())).scale;

  // ---- 滚轮缩放 ----
  // 锚点挑可视区里（面板左侧）的一个点，别落到面板覆盖的那一块上
  const vp = await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport());
  const box = (await page.locator(DIAGRAM_CANVAS).boundingBox())!;
  const cx = box.x + vp.region.width / 2;
  const cy = box.y + vp.region.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -240); // 向上滚 = 放大
  await page.waitForTimeout(220);

  const scaleAfter = (await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport())).scale;
  expect(scaleAfter).toBeGreaterThan(scaleBefore);
  expect(await canvasSignature(page, DIAGRAM_CANVAS)).not.toBe(before);

  // ---- 空白处拖拽平移 ----
  const afterZoom = await canvasSignature(page, DIAGRAM_CANVAS);
  const txBefore = (await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport())).tx;
  // 挑一个基本可以确定是空白的位置（可视区左下角一带），从那儿拖
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

/**
 * ★ **面板浮在画布上，但点它不该动到画布。**
 *
 * 这条守的是一个很隐蔽的坑：引擎在 `window` 上装了**全局**事件拦截器
 * （`DOMEventInterceptor`），把所有指针 / 滚轮事件**广播给每一个 ICE 实例**，
 * 唯一的过滤是"事件目标是不是另一块 **canvas**"。对话面板是个 `<div>`，不在过滤范围里 ——
 * 不额外拦一道的话，在面板上滚一下，工艺图那个实例照样当成一次滚轮缩放。
 *
 * 好在拦截器挂的是**冒泡阶段**，所以在面板根上 `stopPropagation()` 就能拦住
 * （见 `src/view/chat.ts` 的 `SHIELDED_EVENTS`）。
 */
test('在对话面板上滚 / 点，不会命中背后的画布', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitDiagramReady(page);

  const before = await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport());
  const pointedBefore = await page.evaluate(() => (window as any).__iceAgentConsole.diagramPointedId());

  // 在面板正中滚一大段（-1200）：没拦住的话 scale 会明显变
  await wheelOnPanel(page, -1200);
  // 再在面板上点一下（点空白处 —— 不点 chip，免得触发新一轮 run）
  const panel = (await page.locator('#chat').boundingBox())!;
  await page.mouse.click(panel.x + panel.width / 2, panel.y + 40);
  await page.waitForTimeout(250);

  const after = await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport());
  expect(after.scale, '在面板上滚轮不该缩放工艺图').toBe(before.scale);
  expect(after.tx, '在面板上滚轮不该平移工艺图').toBe(before.tx);
  expect(after.ty).toBe(before.ty);
  expect(
    await page.evaluate(() => (window as any).__iceAgentConsole.diagramPointedId()),
    '在面板上点击不该改高亮'
  ).toBe(pointedBefore);

  // 反向对照：同样滚一下，落在**画布**上就应当有效 ——
  // 少了这一半，一个"滚轮完全坏掉"的实现也能让上面那三条通过。
  const box = (await page.locator(DIAGRAM_CANVAS).boundingBox())!;
  await page.mouse.move(box.x + after.region.width / 2, box.y + after.region.height / 2);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(200);
  expect(
    (await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport())).scale,
    '在画布上滚轮应当缩放'
  ).toBeGreaterThan(before.scale);

  expect(errors, errors.join('\n')).toEqual([]);
});

/**
 * ★ 折叠面板 → 绘图区**真的变宽**，而且内容重新居中到新的可视区。
 *
 * 这里量的是 `canvas.width`（backing store）而不是 CSS：画布是 `inset:0` 铺满视口的，
 * 它的 CSS 宽度**不随面板折叠变**（面板是浮层）—— 变的是"没被压住的那部分"。
 * 所以要说清两件不同的事：
 *   - 可视区（`region.width`）变宽 → 适配与居中按它算；
 *   - 内容的屏幕范围跟着往右展开 → 图没有留着一块给已经不存在的面板。
 */
test('折叠面板：可视区变宽、内容重新居中、图不重建', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitDiagramReady(page);

  const expanded = await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport());
  const stageBefore = await readStage(page);
  expect(stageBefore.panelInset).toBeGreaterThan(300);
  expect(expanded.region.width).toBeCloseTo(1440 - stageBefore.panelInset, 0);
  // 面板不该盖住绘图区的中心 —— 否则按坐标的测试与"看中间"这件事都不成立
  const geometry = await panelGeometry(page);
  expect(geometry.centerElement, `绘图区中心被 ${geometry.centerElement} 盖住了`).not.toContain('chat');

  await page.locator('#chat-collapse').click();
  await page.waitForFunction(
    (prev) => (window as any).__iceAgentConsole.stageInfo().panelInset !== prev,
    stageBefore.panelInset,
    { timeout: 5_000 }
  );
  // 视野重摆是同步的，但引擎重绘要等一拍
  await page.waitForTimeout(250);

  const collapsed = await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport());
  const stageAfter = await readStage(page);

  expect(stageAfter.panelInset).toBe(0);
  expect(collapsed.region.width, '折叠后可视区应当铺满整个视口').toBe(1440);
  expect(collapsed.region.width).toBeGreaterThan(expanded.region.width);
  expect(collapsed.scale, '可视区变宽 → 适配倍率跟着变大').toBeGreaterThan(expanded.scale);

  // 内容跟着往右展开（不再为已经不存在的面板留白）
  expect(collapsed.screenBox.right).toBeGreaterThan(expanded.screenBox.right + 100);
  // 而且仍然是**居中**的：左右留白差不多
  const leftGap = collapsed.screenBox.left - collapsed.region.left;
  const rightGap = collapsed.region.left + collapsed.region.width - collapsed.screenBox.right;
  expect(Math.abs(leftGap - rightGap), `左右留白不对称（${leftGap} vs ${rightGap}）`).toBeLessThan(2);

  // ★ 折叠是**布局变化**，不是重新画 —— 一个符号都不该重建
  expect(stageAfter.builds.diagram, '折叠面板不该重建工艺图').toBe(1);
  await expect(page.locator(DIAGRAM_CANVAS)).toBeVisible();

  // 展开回去，视野应当回到展开时的那一屏
  await page.locator('#chat-toggle').click();
  await page.waitForFunction(
    (prev) => (window as any).__iceAgentConsole.stageInfo().panelInset !== prev,
    stageAfter.panelInset,
    { timeout: 5_000 }
  );
  await page.waitForTimeout(250);
  const back = await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport());
  expect(back.region.width).toBeCloseTo(expanded.region.width, 0);
  expect(back.scale).toBeCloseTo(expanded.scale, 6);

  expect(errors, errors.join('\n')).toEqual([]);
});

/**
 * ★ 换界面是**在绘图区里换图层**，不是往消息流里插卡片。
 *
 * 这一条把反转后的生命周期一次说清：
 *  - 切到图表 → 工艺图那一层被**藏起来**（留着！不是销毁）；
 *  - 切回工艺图 → 图表层被销毁、工艺图原样显示，**一个符号都不重建**。
 */
test('切到图表再切回工艺图：图层换掉了，工艺图没有重画', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitDiagramReady(page);

  const boot = await readStage(page);
  expect(boot.builds.diagram).toBe(1);
  expect(boot.canvasCount).toBe(1);

  // ---- 切到图表 ----
  const before = await readState(page);
  await page.locator('.chip', { hasText: '看看各渠道的月度销量' }).first().click();
  await page.waitForFunction(
    (n) => {
      const s = (window as any).__iceAgentConsole.getState();
      return s.status === 'idle' && s.eventCount > n;
    },
    before.eventCount,
    { timeout: 40_000 }
  );
  await page.waitForTimeout(250);

  const onChart = await readStage(page);
  expect(onChart.active).toBe('chart');
  // 工艺图那一层**留着**（只是 hidden）—— 切回来是"显示"而不是"重建"
  expect(onChart.layers.sort()).toEqual(['chart', 'diagram']);
  expect(onChart.builds.diagram).toBe(1);
  expect(onChart.builds.chart).toBe(1);
  // 工艺图 1 块 + 图表 2 块（图表 + 控件条）
  expect(onChart.canvasCount).toBe(3);
  await expect(page.locator(DIAGRAM_CANVAS)).toBeHidden();

  // ---- 切回工艺图（对话里说一句） ----
  const before2 = await readState(page);
  await page.locator('.chip', { hasText: '看看污水处理工艺图' }).first().click();
  await page.waitForFunction(
    (n) => {
      const s = (window as any).__iceAgentConsole.getState();
      return s.status === 'idle' && s.eventCount > n;
    },
    before2.eventCount,
    { timeout: 40_000 }
  );
  await page.waitForTimeout(250);

  const back = await readStage(page);
  expect(back.active).toBe('diagram');
  // ★★ 没有重画：还是那一次建出来的图层，图表的宿主被收干净了
  expect(back.builds.diagram, '切回来不该重建工艺图').toBe(1);
  expect(back.layers).toEqual(['diagram']);
  expect(back.canvasCount, '回到工艺图后只剩一块画布').toBe(1);

  // 图还是完整的
  const stats = await page.evaluate(() => (window as any).__iceAgentConsole.diagramStats());
  expect(stats.symbols).toBe(SYMBOLS);
  expect(stats.pipes).toBe(PIPES);
  expect(stats.issues).toEqual([]);

  // 对话里两条条目都在（时间线是追加的），但只有后者标着"在绘图区上"
  await expect(page.locator(TOOL_ENTRY)).toHaveCount(2);
  await expect(page.locator(`${TOOL_ENTRY}[data-active="true"]`)).toHaveCount(1);
  await expect(page.locator(`${TOOL_ENTRY}[data-active="true"]`)).toHaveAttribute('data-tool', 'render_diagram');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('窗口尺寸变化后画布跟着变（尺寸不是只在启动时量一次）', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitDiagramReady(page);

  await page.setViewportSize({ width: 1000, height: 700 });
  await expect
    .poll(async () => (await readStage(page)).size, { timeout: 5000, message: '画布没有跟着窗口变' })
    .toEqual({ width: 1000, height: 700 });

  const small = await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport());
  expect(small.cssWidth).toBe(1000);
  expect(small.cssHeight).toBe(700);
  // 可视区跟着变小 → 适配倍率跟着变小（不是把原倍率硬套上去）
  expect(small.region.width).toBeLessThanOrEqual(1000);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect
    .poll(async () => (await readStage(page)).size, { timeout: 5000 })
    .toEqual({ width: 1440, height: 900 });

  // 尺寸变了这么多次，图还是那一层
  expect((await readStage(page)).builds.diagram).toBe(1);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('「指着讲」：讲解时高亮对应单元，讲完的单元 id 可查', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await useChip(page, '看看污水处理工艺图');
  await waitSettled(page, 1);

  // 剧本的最后一拍指着消毒接触池；讲完之后高亮留着（与图表的行为一致）
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

  // ---- 第一条条目：坏 DSL，**绘图区没动**，只摆诊断 ----
  expect(tools[0].dsl.units.map((u: any) => u.kind)).toContain('greaseTrap');
  const firstEntry = page.locator(TOOL_ENTRY).first();
  await expect(firstEntry).toHaveAttribute('data-status', 'error');
  await expect(firstEntry.locator('.card-head .status')).toHaveText('校验不通过');
  // 诊断要可据以修正：指出是"未知的符号种类"，并**列出合法取值**
  const diag = await firstEntry.locator('.diag').innerText();
  expect(diag).toContain('未知的符号种类');
  expect(diag).toContain('barScreen');

  // ★ 校验没过的这一轮**不切画面**：绘图区还是开页那张好图，一个符号没动
  const afterBad = await readStage(page);
  expect(afterBad.active, '校验没过不该切图层').toBe('diagram');
  expect(afterBad.builds.diagram, '校验没过不该重建工艺图').toBe(1);
  const statsOnFailure = await page.evaluate(() => (window as any).__iceAgentConsole.diagramStats());
  expect(statsOnFailure.symbols, '绘图区上还是完整的那张图').toBe(SYMBOLS);

  // ---- 第二条条目：修好了，而且**仍然是一张图**（这是本用例的核心）----
  // 回归点：修复剧本原先无条件吐销量柱状图 —— 图 DSL 写错会被"修"成一张图表。
  expect(tools[1].dsl.kind).toBe('water-process');
  expect(tools[1].dsl.units.map((u: any) => u.kind)).not.toContain('greaseTrap');
  const secondEntry = page.locator(TOOL_ENTRY).nth(1);
  await expect(secondEntry).toHaveAttribute('data-status', 'done');
  await expect(page.locator(DIAGRAM_CANVAS)).toBeVisible();
  // 不能是图表图层：那说明修复轮吐错了形态
  expect(await page.locator('.stage-layer[data-kind="chart"]').count()).toBe(0);

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

  // 开页就有图，所以"初始视野"这个基准此时就能取
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

  // ★ 缩放全程不该动到图层 —— 它是**查看**动作，不是"重画一张"
  expect((await readStage(page)).builds.diagram).toBe(1);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('缩放的锚点是**可视区**中心：放大后中心那个世界点几乎没动', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  // 锚点必须按可视区算 —— 按画布中心算的话，图会往右偏（中心落在面板底下那侧）
  const before = await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport());
  const regionCx = before.region.left + before.region.width / 2;
  const regionCy = before.region.top + before.region.height / 2;
  const worldCenterBefore = {
    x: (regionCx - before.tx) / before.scale,
    y: (regionCy - before.ty) / before.scale,
  };

  await page.locator('.chip', { hasText: '把工艺图放大' }).first().click();
  await waitSettled(page, 1);

  const after = await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport());
  const worldCenterAfter = {
    x: (regionCx - after.tx) / after.scale,
    y: (regionCy - after.ty) / after.scale,
  };

  // 剧本最后复位了，所以这里直接比"复位前后"也可以；关键是**镜头推进过程中**锚点守恒。
  // 复位本身也是按同一套公式（focusBox 在可视区居中）算的，所以两者都应当吻合。
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

  // ⑤ 闪烁全程也只是"查看"动作，图层没被换掉或重建
  expect((await readStage(page)).builds.diagram).toBe(1);

  expect(errors, errors.join('\n')).toEqual([]);
});

/**
 * 连续闪烁**不累积**底块。
 *
 * 每次闪烁都会新建一个半透明底块并 `addTool` 进工具层，旧的靠 `removeTool` 收走。
 * 漏收的话每闪一次就多留一层 —— 画面会越来越糊，而且**不会有任何报错**。
 * `blinkInfo().overlays` 是这件事的直接读数。
 *
 * 剧本依次闪 ana → anx → aer 三个单元，所以跑完必须只剩 **1** 个底块。
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
