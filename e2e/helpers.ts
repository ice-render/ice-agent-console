import { expect, type Page } from '@playwright/test';

/** 归约后的状态形状。只声明 e2e 用得到的字段。 */
/**
 * 图表那块画布。卡片里现在有**两块** canvas（图表 + 控件条），
 * 所以选择器必须写清楚指的是哪一块 —— `.card canvas` 虽然也能命中第一块，
 * 但那种"靠 DOM 顺序"的写法一旦有人调整顺序就会静默去量错对象。
 */
export const CHART_CANVAS = '.card .chart-wrap canvas';
export const WIDGET_CANVAS = '.card .widget-wrap canvas';

export interface ConsoleState {
  threadId: string;
  runId: string | null;
  /** `waiting` = run 结束了但留着一个待答复的中断。 */
  status: 'idle' | 'running' | 'waiting' | 'error';
  items: Array<{ kind: 'text' | 'tool'; id: string; text?: string; argsRaw?: string; status?: string }>;
  sharedState: any;
  /** 待答复的中断（协议：`RUN_FINISHED.outcome.type === 'interrupt'`）。 */
  interrupt: { id: string; reason: string; message?: string } | null;
  pointAt: { value: any; seq: number } | null;
  diagnostics: string | null;
  error: string | null;
  eventCount: number;
}

export interface ConsoleHandle {
  getState: () => ConsoleState;
  apiUrl: () => string;
}

/** 读应用内部状态。比只看 DOM 强得多——协议层的东西在 DOM 里是看不全的。 */
export async function readState(page: Page): Promise<ConsoleState> {
  return page.evaluate(() => (window as any).__iceAgentConsole.getState());
}

/**
 * 等一次 run 真正跑完。
 *
 * **不能只看 `status === 'idle'`**：点下按钮之后、第一条事件到达之前，状态还是上一轮留下的
 * `idle`，于是等待会立刻返回——测试就在 run 还没开始时往下走了。
 * 所以判据是"空闲 **且** 事件数涨过基线"：这两条同时成立才说明新一轮已经跑完。
 */
export async function waitSettled(page: Page, minEventCount = 1, timeout = 40_000): Promise<void> {
  await page.waitForFunction(
    (min) => {
      const s = (window as any).__iceAgentConsole.getState();
      return s.status === 'idle' && s.eventCount >= min;
    },
    minEventCount,
    { timeout }
  );
}

/** 执行一个会触发 run 的动作，并等它落定。返回落定后的状态。 */
export async function settleAfter(
  page: Page,
  action: () => Promise<void>,
  timeout = 40_000
): Promise<ConsoleState> {
  const before = await readState(page);
  await action();
  await waitSettled(page, before.eventCount + 1, timeout);
  return readState(page);
}

/**
 * 等状态满足条件。用于等"收到第 N 条事件"这类中间态。
 *
 * 谓词会被序列化后在浏览器里执行，所以**不能闭包引用外面的变量**——
 * 需要的基线值要通过 `arg` 传进去（第一版就是踩了这个：谓词里用 `before.eventCount`，
 * 到了浏览器里变成 `ReferenceError: before is not defined`）。
 */
export async function waitForState(
  page: Page,
  predicate: (s: ConsoleState, arg?: any) => boolean,
  arg?: any,
  timeout = 30_000
): Promise<void> {
  await page.waitForFunction(
    ([src, value]: [string, any]) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function('s', 'arg', `return (${src})(s, arg)`);
      return fn((window as any).__iceAgentConsole.getState(), value);
    },
    [predicate.toString(), arg] as [string, any],
    { timeout }
  );
}

/** 点快捷按钮触发剧本（比打字稳，不受输入法影响），并等这一轮跑完。 */
export async function useChip(page: Page, text: string): Promise<ConsoleState> {
  return settleAfter(page, async () => {
    await page.locator('.chip', { hasText: text }).first().click();
  });
}

/** 画布上非透明像素数。用来断言"图真的画出来了"，而不是"canvas 元素存在"。 */
export async function countInk(page: Page, selector = CHART_CANVAS): Promise<number> {
  return page.evaluate((sel) => {
    const canvas = document.querySelector(sel) as HTMLCanvasElement | null;
    if (!canvas) return -1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return -1;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let ink = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) ink++;
    }
    return ink;
  }, selector);
}

/**
 * 画布内容指纹。
 *
 * 用来断言"某件事发生之后画面变了"。比逐个像素对比稳，也不需要知道高亮画在哪。
 */
export async function canvasSignature(page: Page, selector = CHART_CANVAS): Promise<string> {
  return page.evaluate((sel) => {
    const canvas = document.querySelector(sel) as HTMLCanvasElement | null;
    if (!canvas) return 'no-canvas';
    const ctx = canvas.getContext('2d');
    if (!ctx) return 'no-ctx';
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // 采样而不是全量：够灵敏，又不用把几 MB 数据搬出来
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 97) {
      hash ^= data[i];
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }, selector);
}

/** 收集会话期间所有 console / page / 网络错误。判据不能只看"有没有报错"，但零报错是底线。 */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()}`));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`);
  });
  return errors;
}

/**
 * 在图表上点中一个数据点。
 *
 * **canvas 里没有 DOM 目标可以定位**，所以只能按相对坐标试。这里按一组
 * 已实测过的位置依次尝试，命中为止——比写死一个坐标稳（视口或布局微调不会让用例
 * 随机变红），也比"随便点一下然后期望它有反应"有意义：后者红的时候你分不清
 * 是上行断了还是没点中。
 *
 * 返回是否命中。
 */
export async function clickChartItem(page: Page, selector = CHART_CANVAS): Promise<boolean> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) return false;

  // 柱状图的柱子集中在绘图区中下部；这些位置是实测出来的，不是猜的
  const candidates: Array<[number, number]> = [
    [0.1, 0.6],
    [0.12, 0.62],
    [0.16, 0.64],
    [0.2, 0.64],
    [0.26, 0.64],
    [0.1, 0.55],
    [0.18, 0.55],
    [0.3, 0.62],
    [0.4, 0.62],
    [0.5, 0.6],
  ];

  for (const [nx, ny] of candidates) {
    const before = await readState(page);
    await page.mouse.click(box.x + box.width * nx, box.y + box.height * ny);
    try {
      // 命中会同步插一条本地用户消息（不必等整轮 run）
      await page.waitForFunction(
        (n) => (window as any).__iceAgentConsole.getState().items.length > n,
        before.items.length,
        { timeout: 800 }
      );
      return true;
    } catch {
      // 这个位置没命中，换下一个
    }
  }
  return false;
}

/**
 * 点卡片控件条上的某个按钮（按 actionId）。
 *
 * 控件是 canvas 画的，**没有 DOM 目标可以点**，所以从应用挂出来的矩形查询里定位。
 * 矩形是画布内的 CSS 像素偏移，而引擎的坐标语义就是 CSS 像素，所以直接相加即可。
 */
export async function clickWidgetAction(page: Page, actionId: string): Promise<void> {
  const point = await page.evaluate((id) => {
    const rects = (window as any).__iceAgentConsole.widgetRects();
    const hit = rects.find((r: any) => r.id === id);
    if (!hit) return null;
    const canvas = document.querySelector('.card .widget-wrap canvas') as HTMLCanvasElement | null;
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    return {
      x: box.left + hit.left + hit.width / 2,
      y: box.top + hit.top + hit.height / 2,
    };
  }, actionId);

  if (!point) throw new Error(`控件条上找不到「${actionId}」（或控件层还没建出来）`);
  await page.mouse.click(point.x, point.y);
}

/** 统计卡片里的画布数量与各自的着墨量。图表与控件是两张画布，分开数。 */
export async function cardCanvasStats(page: Page): Promise<{
  count: number;
  chart: { width: number; height: number; ink: number } | null;
  widget: { width: number; height: number; ink: number } | null;
}> {
  return page.evaluate(() => {
    const ink = (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return -1;
      const ctx = canvas.getContext('2d');
      if (!ctx) return -1;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) n++;
      return n;
    };
    const size = (canvas: HTMLCanvasElement | null) =>
      canvas ? { width: canvas.width, height: canvas.height, ink: ink(canvas) } : null;

    const card = document.querySelector('.card');
    return {
      count: card ? card.querySelectorAll('canvas').length : 0,
      chart: size(card?.querySelector('.chart-wrap canvas') as HTMLCanvasElement | null),
      widget: size(card?.querySelector('.widget-wrap canvas') as HTMLCanvasElement | null),
    };
  });
}

/** 表单卡的画布。表单与图表**互斥**，同一次 tool call 只会出现其中之一。 */
export const FORM_CANVAS = '.card .form-wrap canvas';

/**
 * 画布上**着墨部分的包围盒**（CSS 像素），以及它占画布的比例。
 *
 * 为什么需要这个而不只是 `countInk`：`countInk` 只回答"画了没有"。
 * 一个表单把 4 个控件画在左边 200px 里、右边空 700px，着墨量照样是几千 ——
 * 那种"画出来了但排得难看"是最容易漏过回归的一类缺陷，得靠**排布**来判。
 *
 * 包围盒按非透明像素算，所以引擎的坐标（逻辑像素）与画布像素的换算要靠
 * `canvas.width / getBoundingClientRect().width`。不能写死 dpr：e2e 里是 1，
 * 但换个 profile 就不是了 —— 写死的话比例会静默错一倍。
 */
export async function inkBounds(
  page: Page,
  selector = CHART_CANVAS
): Promise<{ left: number; top: number; right: number; bottom: number; widthRatio: number; heightRatio: number } | null> {
  return page.evaluate((sel) => {
    const canvas = document.querySelector(sel) as HTMLCanvasElement | null;
    if (!canvas || !canvas.width || !canvas.height) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < canvas.height; y++) {
      const row = y * canvas.width * 4;
      for (let x = 0; x < canvas.width; x++) {
        if (data[row + x * 4 + 3] !== 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;

    const box = canvas.getBoundingClientRect();
    // 逻辑像素 = 画布像素 / (backing / css)
    const scale = box.width > 0 ? canvas.width / box.width : 1;
    return {
      left: minX / scale,
      top: minY / scale,
      right: maxX / scale,
      bottom: maxY / scale,
      widthRatio: canvas.width > 0 ? (maxX - minX + 1) / canvas.width : 0,
      heightRatio: canvas.height > 0 ? (maxY - minY + 1) / canvas.height : 0,
    };
  }, selector);
}

/** 点击最后一张表单卡上的提交按钮（真实点击，不是 programmatic submit）。 */
export async function clickFormSubmit(page: Page): Promise<void> {
  const point = await page.evaluate(() => (window as any).__iceAgentConsole.formSubmitPoint());
  if (!point) throw new Error('没有找到表单卡（或它没有提交按钮）');
  await page.mouse.click(point.x, point.y);
}

/** 往最后一张表单卡里写值。canvas 表单没法用 DOM 填。 */
export async function fillForm(page: Page, values: Record<string, any>): Promise<void> {
  const ok = await page.evaluate((v) => (window as any).__iceAgentConsole.fillForm(v), values);
  if (!ok) throw new Error('没有找到表单卡');
}

/** 读最后一张卡片的表单诊断（`#diag` 那个列表是 DOM，不是 canvas）。 */
export async function formDiagnostics(page: Page): Promise<string[]> {
  return page.locator('.card .diag li').allInnerTexts();
}
