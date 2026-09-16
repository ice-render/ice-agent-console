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
      const left = Math.max(0, box.left + minX / scale - pad);
      const top = Math.max(0, box.top + minY / scale - pad);
      const right = Math.min(window.innerWidth, box.left + (maxX + 1) / scale + pad);
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
  // 单独拍一份"只有图"的，README 的工艺图那一节用它 —— 裁到内容，不然六成是白边
  await shootStage('water-process');
  // 折叠起来的那一份：最能说明"图才是主体"
  await page.locator('#chat-collapse').click();
  await page.waitForTimeout(400);
  await shootStage('full-bleed');
  await page.locator('#chat-toggle').click();
  await page.waitForTimeout(300);

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
