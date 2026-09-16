/**
 * 给 README 拍的截图。
 *
 * ## 布局反转之后，这套脚本也跟着换了主角
 *
 * 以前是"拍 `#app` / 把 `#thread` 滚到底 / 拍 `.card`"。现在：
 *
 * | 拍什么 | 怎么拍 |
 * |---|---|
 * | **绘图区**（工艺图 / 图表 / 表单） | 拍整幅视口 `body`，或拍 `#stage` 里的活动图层 |
 * | **对话面板** | 拍 `#chat`（浮层，自己带圆角与阴影，截出来就是裁好的） |
 *
 * 好处是**不用再滚动了** —— 绘图区铺满视口、不滚动，一屏就是全部内容。
 * 旧版那一堆滚动与"超高元素会被滚动拼接"的绕法全部作废（第 3 条坑还在，
 * 但现在是"面板比视口高时才有意义"，而面板自己会滚，不会长成一条）。
 *
 * ## 仍然有效的两条坑
 *
 * 1. **不能只等 `status`**：上一轮结束时它就已经是 `idle`，等待会立刻返回，
 *    于是下一次点击落在 run 还没开始的时候 —— 而应用有 `if (running) return` 的护栏，
 *    那一次点击被静默吞掉，后面就永远等不到。判据必须是"状态对了 **且** 事件数涨过基线"。
 * 2. **2× 采集**：`deviceScaleFactor: 2`，README 在 retina 上才清晰。
 *
 * 用法：先起服务（`npm run dev`），再 `node scripts/shoot-docs.cjs`。
 */
const path = require('node:path');
const fs = require('node:fs');
const dir = '/Users/felix/Windows-E-workspace/felix/ice-render/ice-agent-console';
const { chromium } = require(path.join(dir, 'node_modules/@playwright/test'));

const OUT = path.join(dir, 'docs/images');
const BASE = process.env.CONSOLE_URL || 'http://127.0.0.1:8100/';

/** 拍整页用的视口。绘图区是铺满的，所以这个尺寸就是"读者看到的一屏"。 */
const VIEW = { width: 1440, height: 900 };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push('console: ' + m.text());
  });

  const shoot = async (name, locator = page.locator('body')) => {
    await locator.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log('  →', `${name}.png`);
  };

  /**
   * 只拍绘图区**有内容的那些像素**（裁到着墨包围盒 + 一圈留白）。
   *
   * 为什么值得多写这二十行：绘图区铺满 1440×900，而工艺图只占中间那块 ——
   * 整幅截下来有六成是白边，README 里既不好看也白占几百 KB。
   * 这是家族 README 一直在用的规矩（"2× 采集 + 按内容包围盒裁切"），
   * 只是以前切的是卡片、现在切的是绘图区。
   *
   * ⚠️ 画布是**视口变换过**的，所以包围盒要在**画布像素**里算，
   * 再按 `backing / css` 换算回页面坐标 —— 不能直接拿 CSS 尺寸当像素用。
   */
  const shootStage = async (name, padding = 24) => {
    const clip = await page.evaluate((pad) => {
      const canvas = document.querySelector('#stage .stage-layer:not([hidden]) canvas');
      if (!canvas) return null;
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
      const scale = box.width > 0 ? canvas.width / box.width : 1;
      // ⚠️ 右边界要夹到**可视区**（= 画布宽度 - 面板遮盖），不能夹到 window.innerWidth ——
      // 后者会把浮在画布上的对话面板切一条进来（第一版拍出来右边挂着一块面板圆角）。
      const viewport = window.__iceAgentConsole.diagramViewport();
      const usableRight = viewport ? viewport.region.width : box.width;
      const left = Math.max(0, box.left + minX / scale - pad);
      const top = Math.max(0, box.top + minY / scale - pad);
      const right = Math.min(usableRight, box.left + (maxX + 1) / scale + pad);
      const bottom = Math.min(window.innerHeight, box.top + (maxY + 1) / scale + pad);
      return { x: left, y: top, width: right - left, height: bottom - top };
    }, padding);

    if (!clip) {
      console.warn('  ! 裁不出内容包围盒，退回整幅');
      return shoot(name, stage());
    }
    await page.screenshot({ path: path.join(OUT, `${name}.png`), clip });
    console.log('  →', `${name}.png`, `(${Math.round(clip.width)}×${Math.round(clip.height)})`);
  };

  /**
   * 拍**被高亮的那个图元**的特写。
   *
   * 为什么单独一个：`pointAt` 会把目标移到**可视区中心**，所以中心那一块就是它 ——
   * 而这个"跟着讲解推近 + 高亮"的效果正是这次要展示的东西，
   * 截成整幅的话框只占几个像素，看不出是个"鲜黄的框"。
   */
  const shootHighlightCloseUp = async (name, size = 520) => {
    const clip = await page.evaluate((half) => {
      const vp = window.__iceAgentConsole.diagramViewport();
      if (!vp) return null;
      const cx = vp.region.left + vp.region.width / 2;
      const cy = vp.region.top + vp.region.height / 2;
      const left = Math.max(0, cx - half);
      const top = Math.max(0, cy - half * 0.62);
      return {
        x: left,
        y: top,
        width: Math.min(half * 2, vp.region.width - left),
        height: Math.min(half * 1.24, vp.region.height - top),
      };
    }, size);

    if (!clip) return shoot(name, stage());
    await page.screenshot({ path: path.join(OUT, `${name}.png`), clip });
    console.log('  →', `${name}.png`, `(${Math.round(clip.width)}×${Math.round(clip.height)} 特写)`);
  };

  /** 只拍绘图区（不带对话面板）—— 用在"图本身才是重点"的那几张。 */
  const stage = () => page.locator('#stage');
  /** 只拍对话面板（浮层）。 */
  const chat = () => page.locator('#chat');

  /**
   * 把视口调高再拍（拍高度大的那一屏）。
   *
   * 表单面板的 `max-height` 是跟着视口走的（`calc(100% - 64px)`，超出自己滚），
   * 所以想在一张图里看全 10 个字段，只能把视口调高 —— 不然拍到一半就断了。
   * 绘图区是铺满视口的，跟着一起变高，正好也符合"这是同一屏"的直觉。
   */
  const needTall = async (height = 1500) => {
    await page.setViewportSize({ width: VIEW.width, height });
    await page.waitForTimeout(400);
  };
  const needWindow = async () => {
    await page.setViewportSize(VIEW);
    await page.waitForTimeout(400);
  };

  /** 点一个快捷按钮并等这一轮真的跑完（判据见文件头第 1 条）。 */
  const chip = async (text, status = 'idle', waitAfter = 900) => {
    const before = await page.evaluate(() => window.__iceAgentConsole.getState().eventCount);
    await page.locator('.chip', { hasText: text }).first().click();
    await page.waitForFunction(
      ([want, min]) => {
        const s = window.__iceAgentConsole.getState();
        return s.status === want && s.eventCount > min;
      },
      [status, before],
      { timeout: 30000 }
    );
    await page.waitForTimeout(waitAfter); // 等淡入 / 收字
  };

  /** 等绘图区真的切到某一层（而且那一层画完了）。比死等一个毫秒数稳。 */
  const onLayer = async (kind) => {
    await page.waitForFunction(
      (want) => {
        const api = window.__iceAgentConsole;
        return api.stageInfo().active === want;
      },
      kind,
      { timeout: 30000 }
    );
    await page.waitForTimeout(350);
  };

  // ---- 1. 首屏 ----
  // "首屏"现在就是**工艺图 + 浮在右边的对话面板**（不是空态）—— 图是开页就画好的。
  await page.goto(BASE);
  await page.waitForFunction(() => !!window.__iceAgentConsole?.diagramStats()?.symbols, undefined, {
    timeout: 20000,
  });
  await page.waitForTimeout(500);
  await shoot('hero');
  // 单独拍一份"只有图"的，README 的工艺图那一节用它 —— 裁到内容，不然六成是白边。
  // 这一步等的是第一个例子（它会一路推镜头，收尾回到**全貌档**），所以拍到的是整张图纸。
  await chip('看看污水处理工艺图');
  await onLayer('diagram');
  // 讲完镜头停在"全貌档"（0.42），直接拍会偏小 —— 主动做一次**整图适配**，
  // 让图纸按可视区铺满再拍（这才是"这张图的定妆照"，跟开页那一屏不是一回事）。
  await page.evaluate(() => window.__iceAgentConsole.fitAll());
  await page.waitForTimeout(400);
  await shootStage('water-process');
  // 折叠起来的那一份：最能说明"图才是主体"
  await page.locator('#chat-collapse').click();
  await page.waitForTimeout(400);
  await shootStage('full-bleed');
  await page.locator('#chat-toggle').click();
  await page.waitForTimeout(300);

  // ---- 1b. 指着讲 + 鲜黄高亮（推到单格档，让高亮的框占够像素）----
  // 这一张是"随讲解放大 + 把对应图元高亮"那条要求的直接证据：
  // 画面是**推近过的**（不是全貌），而被讲的那个池子套着鲜黄的框。
  await page.locator('.chip', { hasText: '让图元闪烁' }).first().click();
  // 闪烁是有时限的（6 轮 × 160ms），所以**等它把高亮打上去就立刻拍**，
  // 不能等整轮跑完 —— 那时候三拍已经闪过去了。
  await page.waitForFunction(() => !!window.__iceAgentConsole?.diagramPointedId?.(), undefined, {
    timeout: 30_000,
  });
  // 等这一拍的推镜头补间走完（220ms）再加一点余量，否则拍到的是中间态
  await page.waitForTimeout(600);
  await shootHighlightCloseUp('highlight');

  // ⚠️ 拍完必须**等这一轮真的跑完**再往下走：闪烁剧本还有两拍，
  //    而应用有 `if (running) return` 的护栏 —— 抢跑的下一次点击会被静默吞掉，
  //    后面就卡在 `onLayer('chart')` 上等到超时（第一版就是这么挂的）。
  await page.waitForFunction(() => window.__iceAgentConsole.getState().status === 'idle', undefined, {
    timeout: 30_000,
  });

  // ---- 1c. 改图：提标改造（拆一处、加三处）----
  // 两张对照图，都做整图适配 —— 这样"哪里少了、哪里多了"一眼能对上。
  await page.evaluate(() => window.__iceAgentConsole.fitAll());
  await page.waitForTimeout(400);
  await shootStage('upgrade-before');
  await chip('提标改造');
  await page.evaluate(() => window.__iceAgentConsole.fitAll());
  await page.waitForTimeout(400);
  await shootStage('upgrade');

  // ---- 2. 图表 + 「指着讲」（主链路）----
  await chip('看看各渠道的月度销量');
  await onLayer('chart');
  await shoot('chart');

  // ---- 3. 流式追加：走 appendData 快路径，同一张图逐拍长数据 ----
  await chip('看一下实时吞吐量');
  await onLayer('chart');
  // 必须等三拍追加完（`chip` 只等到 idle，而追加的三拍都在同一个 run 里 —— 所以这里是对的）
  await shoot('streaming');

  // ---- 4. 人机回环：中断 → 表单图层（停在 waiting）----
  // 表单比一屏高（它自己会滚），所以后面几张先把视口调高，不然拍到一半就断了
  await needTall();
  await chip('要下发指令', 'waiting', 700);
  await onLayer('form');
  await shoot('form-card');

  // ---- 5. 新控件原型（10 个字段，最高的一张）----
  await chip('看看新控件都能用吗');
  await onLayer('form');
  await shoot('showcase');
  await needWindow();

  // ---- 6. 自修复：坏 DSL 那一轮的条目 + 诊断 ----
  // 修复轮会把图表切上绘图区，所以这张要拍**对话面板** —— 诊断只挂在那条条目上。
  // 面板得滚到那条：它是最后一条 `data-status="error"` 的（下面还跟着修复轮的两句话）。
  await chip('故意画错');
  await onLayer('chart');
  await page.locator('.tool-entry[data-status="error"]').last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shoot('self-repair', chat());

  console.log('错误 =', errs.length ? errs : '无');
  await browser.close();
})();
