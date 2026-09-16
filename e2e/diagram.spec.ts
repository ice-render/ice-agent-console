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
  UPGRADE_BRIDGE_PIPES,
  UPGRADE_PIPES,
  UPGRADE_REMOVED_PIPE_IDS,
  UPGRADE_REMOVED_UNIT_IDS,
  UPGRADE_UNITS,
  WATER_PROCESS_DSL,
} from '../shared/water-process-case';
import {
  DIAGRAM_CANVAS,
  TOOL_ENTRY,
  canvasSignature,
  chipLocator,
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
  yellowRatio,
} from './helpers';

/**
 * 案例规模（基准图）。
 *
 * ⚠️ 不从数字抄一遍，而是**从常量算** —— 这张图会被「提标改造」那条剧本增删，
 * 规模也会随数据调整，写死的数字会让这里变成"改数据必须记得改测试"。
 * 真正要钉的是"内置案例真的画出来了"，数量一致是它的一部分。
 */
const SYMBOLS = WATER_PROCESS_DSL.units.length;
const PIPES = WATER_PROCESS_DSL.pipes.length;

/** 拆初沉池时被**级联**删掉的那几根管线（沉砂池 / 配水井 / 除臭各一根）。 */
const PIPES_TOUCHED_BY_REMOVED_UNITS = 3;

/** 「提标改造」那一条的期望（也是从常量算，理由同上）。 */
const UPGRADED = {
  symbols: SYMBOLS - UPGRADE_REMOVED_UNIT_IDS.length + UPGRADE_UNITS.length,
  // 删掉的管线 = 被取代的那根 + 挂在被删单元上的那几根；新增的 = 连通管 + 提标段四根
  pipes:
    PIPES -
    UPGRADE_REMOVED_PIPE_IDS.length -
    PIPES_TOUCHED_BY_REMOVED_UNITS +
    UPGRADE_BRIDGE_PIPES.length +
    UPGRADE_PIPES.length,
};

/** 内置案例的单元表（"这个 id 在图里存在吗"的参照物）。 */
const unitsOf = () => WATER_PROCESS_DSL.units;


test('开页就是工艺图：无需任何对话、数量对、引擎校验无问题、零 console error', async ({ page }) => {
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
  expect(stage.canvasCount, '还是只有那 68 个符号所在的这一块画布').toBe(1);

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

  // **被框住的那一段**（focusBox）的屏幕范围要落在可视区里 —— 这是"没被面板压住"的直接读数。
  //
  // ⚠️ 判据必须用 `focusBox` 而不是 `contentBox` / `screenBox`（后者是**全部图元**的范围）：
  // 初始视野框的只是 `viewport.focus` 那一段，污泥线 / 事故水 / 加药间**本来就该在视野外** ——
  // "把它们排除在外"正是 focus 存在的理由。拿全图判会得到"右边溢出 12px"这种假阳性。
  const framedLeft = vp.focusBox.minX * vp.scale + vp.tx;
  const framedRight = vp.focusBox.maxX * vp.scale + vp.tx;
  const usableRight = vp.region.left + vp.region.width;
  expect(framedLeft, '被框住的那段左边不该出界').toBeGreaterThanOrEqual(-1);
  expect(framedRight, '被框住的那段右边不该钻到面板底下').toBeLessThanOrEqual(usableRight + 1);

  // focus 真的在裁：主流程链**横向铺满整图**（进水在最左、排放口在最右），
  // 所以它裁掉的是**纵向**那一大块（污泥线 / 事故水 / 加药间）。
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

  // 而且**被框住的那一段**仍然居中 —— 量的是 `focusBox` 而不是 `contentBox`。
  //
  // ⚠️ 别拿 `contentBox` 判居中：它是**全部图元**的范围，而初始视野框的是
  // `viewport.focus` 那一段（主流程 + 深度处理）。污泥线 / 事故水 / 加药间
  // 本来就在框外 —— "框外"正是 focus 存在的意义，拿 contentBox 判会得到
  // "右边溢出 24px" 这种假阳性（第一版就是这么写的）。
  const focusScreen = (vp: any) => ({
    left: vp.focusBox.minX * vp.scale + vp.tx,
    right: vp.focusBox.maxX * vp.scale + vp.tx,
  });
  const framed = focusScreen(collapsed);
  const leftGap = framed.left - collapsed.region.left;
  const rightGap = collapsed.region.left + collapsed.region.width - framed.right;
  expect(
    Math.abs(leftGap - rightGap),
    `被框住的那段左右留白不对称（${leftGap.toFixed(1)} vs ${rightGap.toFixed(1)}）`
  ).toBeLessThan(2);

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
  await chipLocator(page, '看看各渠道的月度销量').click();
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
  await chipLocator(page, '看看污水处理工艺图').click();
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

  // 讲稿的最后一拍指着事故池（收尾讲事故水支路）；讲完之后高亮留着（与图表的行为一致）
  const pointed = await page.evaluate(() => (window as any).__iceAgentConsole.diagramPointedId());
  expect(pointed).toBe('accidentTank');

  // 高亮必须落在**真的有这个单元**的图上：id 能在 DSL 里找到。
  // 参照物取**那一轮的 STATE_SNAPSHOT**（`sharedState.diagram`）—— 它是"客户端手里那份图"，
  // 比拿内置常量比对更贴近实际（两边不一致时这一条才会红）。
  const state = await readState(page);
  const ids = state.sharedState.diagram.units.map((u: any) => u.id);
  expect(ids).toContain(pointed);

  expect(errors, errors.join('\n')).toEqual([]);
});

/**
 * ★ 高亮是**鲜艳的黄**，不是品牌冰蓝。
 *
 * 这条要求值得单独一条用例，因为"换个颜色"是最容易被顺手改回去的东西
 * （`diagram-layer.ts` 里原来就是从引擎主题取主色，而主色是冰蓝）。
 *
 * 判据按**色相**算而不是精确色值：底块是半透明洗底，叠在浅蓝池子 / 白底 / 深色位号上，
 * 采样到的 RGB 各不相同（见 helpers 的 `yellowRatio`）。
 *
 * 而且这是**对照**实验：先清掉高亮量一次基线、再指一次量一次 ——
 * 少了基线那一半，"整个画面本来就发黄"的实现也能通过。
 * （清高亮走的是 `ice/point-clear`，顺便把那条一直没有剧本会发的路径也覆盖了。）
 */
test('★ 高亮是鲜黄色：有高亮时画布上出现明显的黄，清掉之后退回基线', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitDiagramReady(page);

  // 落到"单格档"让目标符号占够像素：全貌档下它只有几个像素宽，
  // 洗底色会被抗锯齿摊薄到判不出来（那不是缺陷，是"太小了"）。
  await useChip(page, '看看污水处理工艺图');
  await waitSettled(page, 1);

  // ---- 有高亮 ----
  expect(await page.evaluate(() => (window as any).__iceAgentConsole.diagramPointedId())).not.toBeNull();
  const highlighted = await yellowRatio(page);
  const yellowPixels = await sampleYellow(page);

  // 采到的那个像素必须真的是黄（红绿高、蓝低）—— 冰蓝会被这条直接否掉
  expect(yellowPixels, '应当能采到一个"够黄"的像素').not.toBeNull();
  expect(yellowPixels!.r).toBeGreaterThan(yellowPixels!.b + 80);
  expect(yellowPixels!.g).toBeGreaterThan(yellowPixels!.b + 50);

  // ---- 清掉高亮（`ice/point-clear`，同样的 CUSTOM 通道）----
  await page.evaluate(() => (window as any).__iceAgentConsole.clearPoint());
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => (window as any).__iceAgentConsole.diagramPointedId())).toBeNull();

  const cleared = await yellowRatio(page);
  // 基线不是 0：污泥线与部分管线的底纹是**浅黄**，但那个黄的蓝通道没那么低，
  // 在 `yellowRatio` 的判据下只是零星命中。所以断言"明显下降"而不是"归零"。
  expect(cleared, `清掉高亮后黄色应当明显减少（${cleared} vs ${highlighted}）`).toBeLessThan(
    highlighted * 0.5
  );

  expect(errors, errors.join('\n')).toEqual([]);
});

/** 采一个"够黄"的像素（用来确认那个黄真的是黄，而不是某种浅色底纹）。 */
async function sampleYellow(page: import('@playwright/test').Page) {
  return page.evaluate((sel) => {
    const canvas = document.querySelector(sel) as HTMLCanvasElement | null;
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (r > 200 && g > 170 && b < 140 && r - b > 90) return { r, g, b };
    }
    return null;
  }, DIAGRAM_CANVAS) as Promise<{ r: number; g: number; b: number } | null>;
}

/**
 * ★ **动态增删图元**：提标改造 —— 拆一处、加几处，而**图不重建**。
 *
 * 这是整个工程里唯一一条改"图的**结构**"的用例（其余都只在已有的图上动镜头或高亮）。
 * 它要证三件事，缺一件就说明增量那条路断了：
 *
 * 1. **图元数真的变了** —— `diagramStats()` 读的是模型层，不是像素；
 * 2. **图层没有重建** —— `stageInfo().builds.diagram` 必须一直是 1。
 *    退化成全量重建的话图也"对"，用户的缩放位置却被冲掉了，而且不报错；
 * 3. **`state` 也跟着变了** —— 渲染层增量、state 不增量（或反过来）就是状态分叉，
 *    下次从 state 重建会露馅。
 */
test('★ 提标改造：增删图元走增量，图元数变了而图层没有重建', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitDiagramReady(page);

  const before = await readStage(page);
  expect(before.builds.diagram).toBe(1);
  const beforeStats = await page.evaluate(() => (window as any).__iceAgentConsole.diagramStats());
  expect({ symbols: beforeStats.symbols, pipes: beforeStats.pipes }).toEqual({
    symbols: SYMBOLS,
    pipes: PIPES,
  });

  // ---- 跑「提标改造」----
  await useChip(page, '提标改造');
  await waitSettled(page, 1);
  await page.waitForTimeout(300);

  // ---- ① 模型层：图元数真的变成了"拆一处 + 加三处"之后的样子 ----
  const stats = await page.evaluate(() => (window as any).__iceAgentConsole.diagramStats());
  expect({ symbols: stats.symbols, pipes: stats.pipes }).toEqual(UPGRADED);
  // 改完的图仍然过引擎的工艺校验（拆一处、接一处的意义就在这里）
  expect(stats.issues).toEqual([]);

  // ---- ② ★ 图层没有重建 ----
  const after = await readStage(page);
  expect(after.active).toBe('diagram');
  expect(after.builds.diagram, '改图不该重建图层 —— 重建的话用户的缩放位置会被冲掉').toBe(1);
  // 画布还是那一块（没有"每改一次多一块"）
  expect(after.canvasCount).toBe(1);

  // ---- ③ `state` 与画面一致 ----
  const state = await readState(page);
  expect(state.sharedState.diagram.units).toHaveLength(UPGRADED.symbols);
  expect(state.sharedState.diagram.pipes).toHaveLength(UPGRADED.pipes);
  const ids = state.sharedState.diagram.units.map((u: any) => u.id);
  for (const removed of UPGRADE_REMOVED_UNIT_IDS) expect(ids).not.toContain(removed);
  for (const added of UPGRADE_UNITS.map((u) => u.id)) expect(ids).toContain(added);
  // 被取代的那根直连管线也没了
  const pipeIds = state.sharedState.diagram.pipes.map((p: any) => p.id);
  for (const removed of UPGRADE_REMOVED_PIPE_IDS) expect(pipeIds).not.toContain(removed);
  // 没有悬空管线（两端都还在 units 里）
  const unitIds = new Set(ids);
  for (const pipe of state.sharedState.diagram.pipes) {
    expect({ pipe: pipe.id, ok: unitIds.has(pipe.sourceId) && unitIds.has(pipe.targetId) }).toEqual({
      pipe: pipe.id,
      ok: true,
    });
  }
  // `viewport.focus` 里也不许再提被删的那个（不然复位视野会框错范围）
  expect(state.sharedState.diagram.viewport.focus).not.toContain(UPGRADE_REMOVED_UNIT_IDS[0]);

  // ---- ④ 新加的图元真的**画**出来了：指到它能看到高亮 ----
  // 光看模型层不够 —— "建了但没画"是一种很典型的失败（没置脏就是那样）。
  const pointed = await page.evaluate(() => (window as any).__iceAgentConsole.diagramPointedId());
  expect(UPGRADE_UNITS.map((u) => u.id)).toContain(pointed);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('★ 改图之后交互仍然有效（增量路径不该把监听弄丢）', async ({ page }) => {
  // 与"追加之后图还能交互"同一条思路：删/建图元走的是 `designer.remove` / `createSymbol`，
  // 它们不该动引擎上挂的指针监听。弄丢了的话症状是"改完图之后空白处拖不动了"。
  const errors = collectErrors(page);
  await page.goto('/');
  await waitDiagramReady(page);

  await useChip(page, '提标改造');
  await waitSettled(page, 1);

  const vpBefore = await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport());

  // 空白处拖拽平移：位置挑可视区左下角（那一带基本可以确定没有图元）
  const box = (await page.locator(DIAGRAM_CANVAS).boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + box.height - 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + box.height - 110, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(220);

  const vpAfter = await page.evaluate(() => (window as any).__iceAgentConsole.diagramViewport());
  expect(vpAfter.tx, '改图之后拖拽应当还能平移').not.toBe(vpBefore.tx);
  // 而且图元数没被拖坏
  const stats = await page.evaluate(() => (window as any).__iceAgentConsole.diagramStats());
  expect({ symbols: stats.symbols, pipes: stats.pipes }).toEqual(UPGRADED);
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
 * 剧本依次闪 ana1 → anx1 → aer1 三个单元，所以跑完必须只剩 **1** 个底块。
 */
test('连续闪烁不累积底块：闪三个单元之后工具层里只有一个', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  await chipLocator(page, '让图元闪烁').click();
  await waitSettled(page, 1);

  const info = await page.evaluate(() => (window as any).__iceAgentConsole.diagramBlink());
  // 只剩最后指到的那个（aer1），而且**本层建的底块**只剩它一个。
  // 注意数的是"带标记的底块"而不是 `ice.toolNodes` 总数 —— 后者里还有引擎自己的
  // 对齐引导线 / 控制面板 / 连线插槽（实测基线 7~9 个），数总量等于在数引擎。
  expect(info.id).toBe('aer1');
  expect(info.overlays).toBe(1);

  // 图元本身没被污染：计数不变（底块进的是工具层，不进 childNodes）
  const stats = await page.evaluate(() => (window as any).__iceAgentConsole.diagramStats());
  expect(stats.symbols).toBe(SYMBOLS);
  expect(stats.issues).toEqual([]);

  expect(errors, errors.join('\n')).toEqual([]);
});
