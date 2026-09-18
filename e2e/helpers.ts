import { expect, type Page } from '@playwright/test';

/**
 * 绘图区与对话面板的选择器。
 *
 * ⚠️ 布局反转之后，**画布不再在对话里**：绘图区是铺满视口的一块，按**图层种类**分开；
 * 对话里只剩"工具条目"（`.tool-entry`，纯 DOM，没有画布）。
 *
 * 所以三种内容各自的画布要用 `[data-kind=…]` 指名 —— 那句"不要用 `.card canvas`，
 * 一旦有人调整顺序就会静默量错对象"的教训仍然成立，只是 `data-kind` 比 DOM 顺序稳得多。
 */
export const DIAGRAM_CANVAS = '.stage-layer[data-kind="diagram"] canvas';
export const CHART_CANVAS = '.stage-layer[data-kind="chart"] .stage-chart canvas';
export const WIDGET_CANVAS = '.stage-layer[data-kind="chart"] .stage-widget canvas';
export const FORM_CANVAS = '.stage-layer[data-kind="form"] canvas';

/** 对话面板里的工具条目（**没有画布**，只是这次 tool call 的回执）。 */
export const TOOL_ENTRY = '.tool-entry';

/**
 * 绘图区事实。`builds` 是"有没有重画"的直接读数 —— 切走再切回来时它必须不变。
 */
export interface StageInfo {
  active: 'diagram' | 'chart' | 'form' | null;
  layers: string[];
  /** 当前**真的显示着**的层（工艺图 + 可能压在上面的那张卡片）。 */
  visible: string[];
  builds: Record<string, number>;
  shows: Record<string, number>;
  canvasCount: number;
  size: { width: number; height: number };
  panelInset: number;
}

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

/** 图表 / 内容写进视口的方式：画布在哪儿、内容画到屏幕哪儿了。 */
export interface DiagramViewport {
  scale: number;
  tx: number;
  ty: number;
  cssWidth: number;
  cssHeight: number;
  /** 画布上没被对话面板压住的那块（CSS 像素）。 */
  region: { left: number; top: number; width: number; height: number };
  screenBox: { left: number; top: number; right: number; bottom: number } | null;
  contentBox: { minX: number; minY: number; maxX: number; maxY: number } | null;
  focusBox: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

export interface ConsoleHandle {
  getState: () => ConsoleState;
  apiUrl: () => string;
  /** 绘图区：当前是哪种图层、各层建过几次、几块画布。 */
  stageInfo: () => StageInfo;
  /** 工艺图的模型层事实（没有工艺图图层时 null）。 */
  diagramStats: () => { symbols: number; pipes: number; issues: any[] } | null;
  /** 工艺图里被「指着讲」高亮的单元 id。 */
  diagramPointedId: () => string | null;
  /** 工艺图的视口与内容屏幕范围。 */
  diagramViewport: () => DiagramViewport | null;
}

/** 读应用内部状态。比只看 DOM 强得多——协议层的东西在 DOM 里是看不全的。 */
export async function readState(page: Page): Promise<ConsoleState> {
  return page.evaluate(() => (window as any).__iceAgentConsole.getState());
}

/** 读绘图区事实（当前图层 / 各层建过几次 / 几块画布）。 */
export async function readStage(page: Page): Promise<StageInfo> {
  return page.evaluate(() => (window as any).__iceAgentConsole.stageInfo());
}

/**
 * 等**开页就绪**：绘图区上已经有工艺图，而且 78 个符号都建好了。
 *
 * ⚠️ 这里**不能用 `waitSettled`**：那条判据要求 `eventCount` 涨过基线，
 * 而开页是不跑 run 的 —— 没跟 AI 说过话时 `eventCount` 一直是 0，
 * 拿它当判据会一直等到超时。（这一条踩过：四条用例整片红在超时上。）
 */
export async function waitDiagramReady(page: Page, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const api = (window as any).__iceAgentConsole;
      const info = api.stageInfo();
      const stats = api.diagramStats();
      return info.active === 'diagram' && !!stats && stats.symbols > 0;
    },
    undefined,
    { timeout }
  );
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
/**
 * 点某个快捷按钮。**按精确文案匹配**，不是子串。
 *
 * ⚠️ 这条是踩出来的：`locator('.chip', { hasText })` 是**子串**匹配，
 * 而按钮里有一对只差三个字的 —— `故意画错` 与 `故意画错工艺图`。
 * 于是 `hasText: '故意画错'` 会同时命中两个，`.first()` 的结果就**取决于 DOM 顺序**。
 *
 * 它一直是颗雷：最初能过只是因为"图表那个恰好排在工艺图那个前面"。
 * 后来把按钮按"作用对象"分组（工艺图那组排最前），顺序一换就立刻踩响 ——
 * 点 `故意画错` 变成了点 `故意画错工艺图`，测试拿到的是图 DSL，报了个看不出所以然的错。
 *
 * 所以这里用 `exact`。**别改回 hasText** —— 那种写法把"测试点的是哪个按钮"
 * 绑在了排版顺序上，而排版是会变的。
 */
export function chipLocator(page: Page, text: string) {
  return page.getByRole('button', { name: text, exact: true });
}

/** 点一个快捷按钮（精确匹配，见 `chipLocator`），并等这一轮跑完。 */
export async function useChip(page: Page, text: string): Promise<ConsoleState> {
  return settleAfter(page, async () => {
    await chipLocator(page, text).click();
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
 * 点绘图区底部控件条上的某个按钮（按 actionId）。
 *
 * 控件是 canvas 画的，**没有 DOM 目标可以点**，所以从应用挂出来的矩形查询里定位。
 * 矩形是画布内的 CSS 像素偏移，而引擎的坐标语义就是 CSS 像素，所以直接相加即可。
 */
export async function clickWidgetAction(page: Page, actionId: string): Promise<void> {
  const point = await page.evaluate((id) => {
    const rects = (window as any).__iceAgentConsole.widgetRects();
    const hit = rects.find((r: any) => r.id === id);
    if (!hit) return null;
    const canvas = document.querySelector('.stage-layer[data-kind="chart"] .stage-widget canvas') as HTMLCanvasElement | null;
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

/** 一块画布的尺寸与着墨量。 */
export interface CanvasStat {
  width: number;
  height: number;
  ink: number;
}

/**
 * 绘图区**当前显示的那一层**有几块画布、各自多大、着墨多少。
 *
 * 旧版是 `cardCanvasStats()`：数一张卡片里的画布。那个概念没有了 ——
 * 画布现在按图层分（图表层两块：图表 + 控件条），而且非活动层会被收掉，
 * 所以这里按 `[data-kind]` 分别问。
 */
export async function stageStats(page: Page): Promise<{
  layers: number;
  canvases: number;
  diagram: CanvasStat | null;
  chart: CanvasStat | null;
  widget: CanvasStat | null;
  form: CanvasStat | null;
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
    const stat = (sel: string): CanvasStat | null => {
      const canvas = document.querySelector(sel) as HTMLCanvasElement | null;
      return canvas ? { width: canvas.width, height: canvas.height, ink: ink(canvas) } : null;
    };
    const stage = document.querySelector('#stage');
    return {
      layers: stage ? stage.querySelectorAll('.stage-layer').length : 0,
      canvases: stage ? stage.querySelectorAll('canvas').length : 0,
      diagram: stat('.stage-layer[data-kind="diagram"] canvas'),
      chart: stat('.stage-layer[data-kind="chart"] .stage-chart canvas'),
      widget: stat('.stage-layer[data-kind="chart"] .stage-widget canvas'),
      form: stat('.stage-layer[data-kind="form"] canvas'),
    };
  }) as Promise<{
    layers: number;
    canvases: number;
    diagram: CanvasStat | null;
    chart: CanvasStat | null;
    widget: CanvasStat | null;
    form: CanvasStat | null;
  }>;
}

/**
 * 工艺图那块画布（历史名字保留：`DIAGRAM_CANVAS` 的简写）。
 *
 * 与 `CHART_CANVAS` / `FORM_CANVAS` 并列：选择器指名**图层**，
 * **不要**写 `#stage canvas` —— 绘图区里可能有不止一块画布（图表层就有两块），
 * 靠 DOM 顺序命中一旦有人调整顺序就会静默量错对象。
 */
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

/** 往表单里写值。canvas 表单没法用 DOM 填。 */
export async function fillForm(page: Page, values: Record<string, any>): Promise<void> {
  const ok = await page.evaluate((v) => (window as any).__iceAgentConsole.fillForm(v), values);
  if (!ok) throw new Error('绘图区上现在不是表单图层');
}

/** 读表单诊断（`.diag` 那个列表是 DOM，不是 canvas）。 */
export async function formDiagnostics(page: Page): Promise<string[]> {
  return page.locator(`${TOOL_ENTRY} .diag li`).allInnerTexts();
}

/**
 * 对话面板的几何。
 *
 * 布局反转之后"面板浮在绘图区上"这件事本身是**有风险**的（面板会压住画布、
 * 也可能挡住按坐标点的测试），所以它得能被断言：返回面板矩形、视口尺寸，
 * 以及"绘图区中心点有没有被面板盖住"。
 */
export async function panelGeometry(page: Page): Promise<{
  panel: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  /** 面板左边缘的 x —— 面板左边往左都是"没被压住的绘图区" */
  coveredFromX: number;
  /** 绘图区中心那个点当前落在哪个元素上（应当**不是** canvas 就是没被压住） */
  centerElement: string | null;
  collapsed: boolean;
}> {
  return page.evaluate(() => {
    const chat = document.querySelector('#chat') as HTMLElement;
    const r = chat.getBoundingClientRect();
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const el = document.elementFromPoint(cx, cy);
    return {
      panel: { x: r.left, y: r.top, width: r.width, height: r.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      coveredFromX: r.left,
      centerElement: el ? `${el.tagName}.${(el as HTMLElement).className}` : null,
      collapsed: chat.dataset.collapsed === 'true',
    };
  });
}

/** 在对话面板上滚一下 —— 用来验证画布的全局事件拦截器没被误触发。 */
export async function wheelOnPanel(page: Page, deltaY = -400): Promise<void> {
  const box = (await page.locator('#chat').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}

/**
 * 画布上"够黄"的像素占比。
 *
 * 为什么要按**色相**判而不是按精确色值：高亮底块是半透明洗底，叠在浅蓝的池子上、
 * 白底上、深色位号上，采样到的 RGB 各不相同；再去抠抗锯齿边缘根本没有意义。
 * 但"黄"这件事在色相上是稳定的 —— 红绿高、蓝很低。
 *
 * 这个读数用来钉"高亮是鲜艳的黄色"这条要求（而不是品牌冰蓝）：
 * 冰蓝的红绿低、蓝高，在下面这套判据里会被判成 0。
 */
export async function yellowRatio(page: Page, selector = DIAGRAM_CANVAS): Promise<number> {
  return page.evaluate((sel) => {
    const canvas = document.querySelector(sel) as HTMLCanvasElement | null;
    if (!canvas) return -1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return -1;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let total = 0;
    let yellow = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue; // 透明像素不算
      total++;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      // 黄 = R、G 都显著高于 B，且自身够亮（挡住灰与浅黄底纹）
      if (r > 200 && g > 170 && b < 140 && r - b > 90 && g - b > 60) yellow++;
    }
    return total > 0 ? yellow / total : 0;
  }, selector);
}

/**
 * 对话面板（`#thread`）的滚动读数。
 *
 * `fromBottom` 是**距底部还有多少像素** —— 判"有没有跟到底部"要用它而不是 `scrollTop`：
 * 内容一长，`scrollTop` 的"底部值"就变了，拿绝对值判等于把断言绑在内容高度上。
 */
export async function chatScroll(page: Page): Promise<{
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  fromBottom: number;
}> {
  return page.evaluate(() => {
    const el = document.getElementById('thread')!;
    return {
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      fromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
    };
  });
}

/** 把对话面板滚到某个位置（`0` = 最上面）。等一拍让 `scroll` 事件派发出去。 */
export async function scrollChatTo(page: Page, top: number | 'bottom'): Promise<void> {
  await page.evaluate((target) => {
    const el = document.getElementById('thread')!;
    el.scrollTop = target === 'bottom' ? el.scrollHeight : target;
  }, top);
  // `scroll` 事件是异步派发的，而"跟随/松手"的判断就发生在那个监听里
  await page.waitForTimeout(80);
}

/** 折叠 / 展开对话面板，并等绘图区把尺寸与视野重新摆好。 */
export async function togglePanel(page: Page, collapsed: boolean): Promise<void> {
  const before = await readStage(page);
  if (collapsed) await page.locator('#chat-collapse').click();
  else await page.locator('#chat-toggle').click();
  // `syncPanelInset()` 是同步的，但 ResizeObserver 的派发与引擎的重绘要等一拍。
  // 判据用"面板遮盖宽度真的变了"，比死等一个毫秒数稳。
  await page.waitForFunction(
    (prev) => (window as any).__iceAgentConsole.stageInfo().panelInset !== prev,
    before.panelInset,
    { timeout: 5_000 }
  );
  await page.waitForTimeout(120);
}
