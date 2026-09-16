/**
 * **开页自动开演**：进页面不等任何人点，先把第一个例子演一遍。
 *
 * 见 `src/domain/agui/autoplay.ts` 的模块头。这一组用例要钉住三件事，缺一件都不完整：
 *
 * 1. **它真的会自己跑** —— 而且"缩放"与"高亮"两件事都发生了。
 *    只断言"有消息进来"是不够的：讲稿可能跑了但镜头一次都没动（第一拍那条
 *    `fit` 命令在图层量到尺寸之前就会被丢掉）。
 * 2. **默认不开**（普通构建）—— 否则本地开发与 e2e 全被 19 秒的自动播放污染。
 * 3. **用户一动手就让位** —— 这是"自动播放"能不能讨人喜欢的关键：
 *    `send()` 有 `if (running) return` 的护栏，不主动取消的话，
 *    开页那 19 秒里点按钮 / 打字会被**静默吞掉**，页面看着能点其实没反应。
 *    第三条是这三条里最容易漏、也最招人烦的一条。
 *
 * ## 用的是普通构建的产物
 *
 * 普通 `npm run build` 的构建期默认是**关**，所以第 1、3 条要靠 `?autoplay=1` 显式打开
 * （运行期覆盖，与 `?demo=` 同一套机制）。这样这份 spec 不需要另做一份演示产物，
 * `playwright.config.ts` 的 `webServer` 也不用改。
 */
import { expect, test, type Page } from '@playwright/test';
import { chipLocator, collectErrors, readState, readStage, waitDiagramReady, waitForState } from './helpers';

/** 开页把镜头与高亮的变化**采样**记下来 —— 用来断言"真的推过镜头、真的指过多个单元"。 */
async function startSampling(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as any).__iceAgentConsole;
    const w = window as any;
    w.__samples = { scales: [], pointed: [] };
    w.__stopSampling = false;
    const tick = () => {
      const z = api.diagramZoom();
      if (z) w.__samples.scales.push(z.scale);
      const id = api.diagramPointedId();
      if (id && w.__samples.pointed[w.__samples.pointed.length - 1] !== id) {
        w.__samples.pointed.push(id);
      }
      if (!w.__stopSampling) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function readSamples(
  page: Page
): Promise<{ scales: number[]; pointed: string[] }> {
  return page.evaluate(() => {
    const w = window as any;
    w.__stopSampling = true;
    return w.__samples;
  });
}

test('★ ?autoplay=1：不点任何东西，开页自己把第一个例子演一遍（镜头推近 + 高亮）', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?autoplay=1');
  await waitDiagramReady(page);

  expect(await page.evaluate(() => (window as any).__iceAgentConsole.autoplayEnabled())).toBe(true);

  await startSampling(page);

  // 不用点任何东西，消息应该自己来
  await waitForState(page, (s) => s.items.length > 0, undefined, 20_000);
  // 然后一路跑到结束（这一轮 ~19 秒：901 个事件 × 节奏）
  await waitForState(page, (s) => s.status === 'idle' && s.eventCount > 300, undefined, 90_000);

  const state = await readState(page);
  const samples = await readSamples(page);

  // ① 它替代用户按下了第一个快捷按钮 —— 面板里就是那句话
  expect(state.items[0]).toMatchObject({ kind: 'text', role: 'user', text: '看看污水处理工艺图' });

  // ② **镜头真的推近过**：讲稿里有 1.5 倍那一档，采样里必须出现过 > 1 的倍率。
  //    这条比"有消息"强得多 —— 少了它，一个"命令被图层丢掉、画面纹丝不动"的实现照样通过。
  const maxScale = Math.max(...samples.scales);
  expect(maxScale, `采样到 ${samples.scales.length} 帧，最大倍率 ${maxScale}`).toBeGreaterThan(1);

  // ③ **高亮真的换过多个单元**（讲稿按工艺段走，一路换着指）
  expect(samples.pointed.length).toBeGreaterThan(5);
  //    收尾指着事故池（讲事故水支路那一拍），与手动点这个按钮的结果一致
  expect(samples.pointed[samples.pointed.length - 1]).toBe('accidentTank');

  // ④ 全程**没有重建图层** —— 自动开演不该把"不重画"这条规矩破掉
  expect((await readStage(page)).builds.diagram).toBe(1);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('普通构建默认**不**自动开演（本地开发与其余用例不受影响）', async ({ page }) => {
  await page.goto('/');
  await waitDiagramReady(page);

  expect(await page.evaluate(() => (window as any).__iceAgentConsole.autoplayEnabled())).toBe(false);

  // 等一会儿，确认不是"慢半拍才开始"
  await page.waitForTimeout(2500);
  const state = await readState(page);
  expect(state.items, '开页不该自己冒出消息').toEqual([]);
  expect(state.eventCount).toBe(0);
  expect(state.status).toBe('idle');
});

test('?autoplay=0 能关掉（演示站点上想安静地自己点）', async ({ page }) => {
  await page.goto('/?autoplay=0');
  await waitDiagramReady(page);

  expect(await page.evaluate(() => (window as any).__iceAgentConsole.autoplayEnabled())).toBe(false);
  await page.waitForTimeout(2500);
  expect((await readState(page)).items).toEqual([]);
});

test('★ 用户一动手就打断自动开演（否则那 19 秒里点什么都没反应）', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?autoplay=1');
  await waitDiagramReady(page);

  // 等自动开演真的跑起来
  await waitForState(page, (s) => s.status === 'running', undefined, 20_000);

  // 这时候抢它的路：点另一个按钮。不取消的话这一下会被 `running` 护栏静默吞掉。
  await chipLocator(page, '看看各渠道的月度销量').click();

  // 用户那一轮真的跑起来了并且跑完了
  await waitForState(page, (s) => s.status === 'idle' && s.sharedState?.chart?.kind === 'bar', undefined, 90_000);

  const state = await readState(page);
  const texts = state.items.filter((i) => i.kind === 'text').map((i) => i.text ?? '');

  // ① 用户那句话进了流 —— 这是"没被吞掉"的直接证据
  expect(texts).toContain('看看各渠道的月度销量');
  // ② 被掐掉的自动开演**留下的半截消息保留着**（它是真发生过的事，抹掉反而看不懂）
  expect(texts).toContain('看看污水处理工艺图');
  // ③ 状态不能卡在"运行中"。取消走的是 AbortSignal，transport 对取消是静默返回的，
  //    所以不会有 RUN_FINISHED 来收拾；但用户那一下接着开了新一轮 run，
  //    RUN_STARTED / RUN_FINISHED 会把状态正常推完 —— 这条断言守的就是"别卡住"。
  expect(state.status).toBe('idle');
  // ④ 画面切到了用户要的图层
  expect((await readStage(page)).active).toBe('chart');

  expect(errors, errors.join('\n')).toEqual([]);
});
