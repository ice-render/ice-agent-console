/**
 * **live 用例**：真要跑到"外面"的那两条路 —— 真模型后端、真演示产物。
 *
 * 与其余 spec 的区别：那些 spec 断言的是**确定性剧本产物**（后端被钉死
 * `ICE_LLM_MODE=scripted`，第 3 张卡片、第 78 个图元……），所以能进 CI 当门禁。
 * 这里反过来：**没有剧本**，模型说什么、画什么由它自己决定，
 * 断言只能落在"该发生的事发生了没有"上 —— 文字非空、画布上有墨、零 console error。
 *
 * 因此这个文件**默认什么都不跑**，要靠环境变量点名：
 *
 * | 变量 | 跑哪一组 | 前置 |
 * |---|---|---|
 * | `ICE_CONSOLE_API_MODE=llm` | 真模型那两条 | `.env` 里配好真实模型（见 `npm run llm:check`） |
 * | `ICE_DEMO_BUILD=1` | 演示产物那一条 | 先 `npm run build:demo`（dist/ 是演示产物） |
 *
 * 想看着跑就叠上 CDP：
 *
 * ```bash
 * ICE_CDP_ENDPOINT=http://127.0.0.1:9223 ICE_CONSOLE_API_MODE=llm \
 *   npm run test:cdp -- e2e/live.spec.ts
 * ```
 */
import { expect, test } from './cdp';
import {
  CHART_CANVAS,
  DIAGRAM_CANVAS,
  collectErrors,
  countInk,
  readStage,
  readState,
  waitDiagramReady,
  waitForState,
  waitSettled,
} from './helpers';

const API_MODE = process.env.ICE_CONSOLE_API_MODE ?? 'scripted';
const LIVE_LLM = API_MODE === 'llm';
const DEMO_BUILD = process.env.ICE_DEMO_BUILD === '1';

/** 助手说过的正文（用户自己那几条不算）。 */
function assistantText(state: Awaited<ReturnType<typeof readState>>): string {
  return (state.items as any[])
    .filter((i) => i.kind === 'text' && i.role !== 'user')
    .map((i) => i.text ?? '')
    .join('\n')
    .trim();
}

/**
 * 对话里不该出现**空气泡**：`kind === 'text'` 却是空白的那一条。
 *
 * 这不是吹毛求疵 —— 真模型这条路上它**必然会来**：模型第一轮把图画完之后，
 * 第二轮经常"只给动作、不给台词"（比如只调 `point_at` 去指两个节点），
 * 而 `buildLlmPlan` 会为"有动作没文字"的拍子推一条 `text: ''`，
 * `planToEvents` 又照发 `TEXT_MESSAGE_START` + 零条 `CONTENT` + `END`，
 * 于是界面上多出一个点都点不动的空白气泡。
 *
 * 剧本模式撞不到：剧本的每一拍都写了台词。
 */
function emptyBubbles(state: Awaited<ReturnType<typeof readState>>): string[] {
  return (state.items as any[])
    .filter((i) => i.kind === 'text' && i.role !== 'user')
    .filter((i) => !String(i.text ?? '').trim())
    .map((i) => String(i.id));
}

/** 真模型一轮要"想 → 调工具 → 再想"，本地推理模型几十秒很正常。 */
const MODEL_TURN_TIMEOUT = 200_000;

test.describe('真模型后端（ICE_CONSOLE_API_MODE=llm）', () => {
  test.skip(!LIVE_LLM, '需要 ICE_CONSOLE_API_MODE=llm —— 否则断言的是剧本产物，不是模型');

  test('后端跑的确实是真模型', async ({ request }) => {
    const res = await request.get('http://localhost:8099/health');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    // 这一条是**前提校验**：`/health` 报 scripted 的话，下面两条就变成
    // "剧本跑得挺好"，看着全绿却什么都没验到。
    expect(body.agent, `后端不是 llm 模式：${JSON.stringify(body)}`).toBe('llm');
    expect(body.model).toBeTruthy();
    console.log(`[live] 后端模型 ${body.model} @ ${body.baseUrl}（${body.reason}）`);
  });

  test('一句话画工艺图：模型自己选工具，画布上真的有墨', async ({ page }) => {
    test.setTimeout(MODEL_TURN_TIMEOUT + 60_000);
    const errors = collectErrors(page);

    await page.goto('/');
    await waitDiagramReady(page);

    // 打字而不是点快捷按钮：快捷按钮是剧本的入口，这里要看模型面对自由输入的样子。
    await page.fill('#input', '画一张污水处理工艺图，包含粗格栅、提升泵、生化池、二沉池，用中文标注');
    await page.keyboard.press('Enter');

    await waitSettled(page, 1, MODEL_TURN_TIMEOUT);
    const state = await readState(page);
    const said = assistantText(state);
    console.log(`[live] 模型回了 ${said.length} 字：${said.slice(0, 120)}…`);
    console.log(`[live] 工具调用：${state.items.filter((i: any) => i.kind === 'tool').length} 次`);
    console.log(`[live] 指着讲：${JSON.stringify(state.pointAt)}`);

    // ① 模型确实动手画了。判据是"画布上有墨"，不是"DOM 里有 canvas" —— 后者全白也算过。
    const stage = await readStage(page);
    expect(stage.active).toBe('diagram');
    expect(await countInk(page, DIAGRAM_CANVAS)).toBeGreaterThan(1000);
    // ② 而且没在对话里留下空气泡（故事见 emptyBubbles 的注释）
    expect(emptyBubbles(state), '模型只给动作没给台词时，plan 仍会发一条空 text').toEqual([]);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('一句话出图表：模型把数字画成图', async ({ page }) => {
    test.setTimeout(MODEL_TURN_TIMEOUT + 60_000);
    const errors = collectErrors(page);

    await page.goto('/');
    await waitDiagramReady(page);

    await page.fill('#input', '把 A 组 85、B 组 60、C 组 42 画成柱状图，标题「三组对比」');
    await page.keyboard.press('Enter');

    await waitSettled(page, 1, MODEL_TURN_TIMEOUT);
    const state = await readState(page);
    const stage = await readStage(page);
    console.log(`[live] 模型回了：${assistantText(state).slice(0, 120)}…`);
    console.log(`[live] 图层：${JSON.stringify(stage.layers)}`);

    expect(stage.layers).toContain('chart');
    expect(await countInk(page, CHART_CANVAS)).toBeGreaterThan(500);
    expect(emptyBubbles(state), '模型只给动作没给台词时，plan 仍会发一条空 text').toEqual([]);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test.describe('演示产物（npm run build:demo 出的 dist/）', () => {
  test.skip(!DEMO_BUILD, '需要 ICE_DEMO_BUILD=1 —— 先 npm run build:demo，dist/ 才是演示产物');

  /**
   * 演示站点上跑的就是这一条路径：**裸链**（不带任何参数）打开，
   * 构建期默认就该是 demo、就该自动开演，而且一个后端请求都不发。
   *
   * 与 `demo-mode.spec.ts` 的分工：那条测的是"普通产物 + `?demo=1`"这个**运行期开关**，
   * 这条测的是"发出去的那份产物"的**构建期默认** —— 后者才是 GitHub Pages 上真实生效的东西
   * （`scripts/deploy-pages.mjs` 只静态检查了 bundle 里的常量，没有真的开页面跑一遍）。
   */
  test('裸链默认就是 demo：自动开演、零后端请求、跑完有内容', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    const backendHits: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('8099')) backendHits.push(req.url());
    });

    await page.goto('/');

    const mode = await page.evaluate(() => (window as any).__iceAgentConsole.runMode());
    expect(mode, '演示产物的裸链默认不是 demo').toBe('demo');
    expect(await page.evaluate(() => (window as any).__iceAgentConsole.autoplayEnabled())).toBe(true);

    // 不点任何东西，剧本自己走完（~19 秒 + 节奏）
    await waitForState(page, (s) => s.items.length > 0, undefined, 30_000);
    await waitForState(page, (s) => s.status === 'idle' && s.eventCount > 300, undefined, 150_000);

    const stage = await readStage(page);
    expect(stage.builds.diagram).toBe(1);
    expect(await countInk(page, DIAGRAM_CANVAS)).toBeGreaterThan(1000);
    expect(backendHits, `演示产物不该碰后端，却发了：${backendHits.join(', ')}`).toEqual([]);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
