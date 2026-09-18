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
 * ## 最后一张是**另开的页面**：演示模式
 *
 * `?demo=1` 走的是另一条 transport，而脚本前面那几十步已经在同一个 `page` 上
 * 跑过十几轮了 —— 拿它去拍演示模式，拍到的其实是"跑了很久的那个页面"。
 * 所以演示模式**另起一个 `browser.newPage()`**，并且顺手做两条断言
 * （`runMode() === 'demo'`、全程没有一个请求打到 8099）：
 * 截图只能证明"画面长得一样"，而这张图要证明的是"它真没连后端"。
 *
 * 用法：先起服务（`npm run dev`），再 `node scripts/shoot-docs.cjs`。
 */
const path = require('node:path');
const fs = require('node:fs');
const dir = '/Users/felix/Windows-E-workspace/felix/ice-render/ice-agent-console';
const { chromium } = require(path.join(dir, 'node_modules/@playwright/test'));

const OUT = path.join(dir, 'docs/images');
const BASE = process.env.CONSOLE_URL || 'http://127.0.0.1:8100/';

/**
 * 拍图统一带上 `?autoplay=0`。
 *
 * 这个脚本用 `npm run dev`（**普通**构建）起服务，本来默认就不自动开演；
 * 但这条参数是**兜底**：一旦有人改成对着演示产物拍（`CONSOLE_URL` 指到 `build:demo` 的
 * 静态站），自动开演会在开页 0.7 秒后抢跑 —— 于是 `hero` 那一步拍到的是"讲到一半"的画面，
 * 而且后面每一张的起点都变了。截图是提交进仓库的产物，拍错了不会让任何测试变红。
 *
 * ⚠️ 每张用 `page.goto` 的图都要带上它（下面几处都是），别只改第一张。
 */
const NO_AUTOPLAY = '?autoplay=0';

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
   *
   * 半宽取 330 是量出来的：可视区 1048 宽时，"单格档"（1.5 倍）下被讲的那个池子
   * 只占 **203×129** 屏幕像素 —— 按整幅裁的话它只有约 20% 宽，看着还是"一张全貌图里
   * 有个小黄框"。裁到 660×409 之后它占约 31%，同时左右还留着相邻池子与管线当上下文
   * （再裁紧就只剩一个孤零零的符号，看不出它接在哪条线上）。
   */
  const shootHighlightCloseUp = async (name, size = 330) => {
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

  /**
   * 等闪烁的底块处于**亮的那半周期**再拍。
   *
   * 为什么不能直接 `waitForTimeout(600)` 拍：闪烁是 `alternate` 的补间
   * （`blinkInfo().opacity` 在 0 与 1 之间来回），随机时刻拍到的可能正好是**最暗那一帧** ——
   * 高亮框几乎透明，"用鲜黄高亮"这件事在图上看不出来，而截图本身不会报错。
   * 判据用 `blinkInfo().animating === false` 不行（那说明闪完了），要的是"还在闪、且正亮着"。
   */
  const waitForBlinkBright = async (threshold = 0.75) => {
    await page.waitForFunction(
      (min) => {
        const b = window.__iceAgentConsole.diagramBlink();
        return !!b?.id && b.opacity >= min;
      },
      threshold,
      { timeout: 10_000 }
    );
  };
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

  /**
   * 点一个快捷按钮并等这一轮真的跑完（判据见文件头第 1 条）。
   *
   * ⚠️ **必须按精确文案匹配**，不能 `locator('.chip', { hasText })` ——
   * 那是子串匹配，而按钮里有一对只差三个字的（`故意画错` / `故意画错工艺图`）。
   * 这个脚本就**因为这个坏掉过一次**：按钮按"作用对象"分组（工艺图那组排最前）之后，
   * `hasText: '故意画错'` 的 `.first()` 变成了 `故意画错工艺图`，于是它切的是 diagram 图层，
   * 后面等的 `onLayer('chart')` 永远等不到、直接超时；而失败点在几步之后，
   * 报出来完全看不出是点错了按钮。截图是**提交进仓库的产物**，所以坏了很久没人发现
   * —— 上一版截图还停在分组之前。e2e 那边同样的坑由 `chipLocator()` 兜着（见 AGENTS.md 第 8 条）。
   */
  const chip = async (text, status = 'idle', waitAfter = 900) => {
    const before = await page.evaluate(() => window.__iceAgentConsole.getState().eventCount);
    await page.getByRole('button', { name: text, exact: true }).click();
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
  await page.goto(BASE + NO_AUTOPLAY);
  await page.waitForFunction(() => !!window.__iceAgentConsole?.diagramStats()?.symbols, undefined, {
    timeout: 20000,
  });
  await page.waitForTimeout(500);
  await shoot('hero');
  // 单独拍一份"只有图"的，README 的工艺图那一节用它 —— 裁到内容，不然六成是白边。
  // 这一步等的是第一个例子（它会一路推镜头，收尾回到**全貌档**），所以拍到的是整张图纸。
  await chip('看看污水处理工艺图');
  await onLayer('diagram');
  // 讲完镜头停在"全貌档"，直接拍会偏小 —— 主动做一次**整图适配**，
  // 让图纸按可视区铺满再拍（这才是"这张图的定妆照"，跟开页那一屏不是一回事）。
  await page.evaluate(() => window.__iceAgentConsole.fitAll());
  // ⚠️ **还要把高亮收掉**：讲解剧本讲完是留着高亮的（`accidentTank`，刻意的 ——
  // 讲完停在被讲的那个池子上很自然）。但这一张是**图纸的定妆照**，读者要拿它认"这张图长什么样"；
  // 上面挂着一个不知从哪来的黄框，只会让人以为是某种标注。所以定妆照一律先清高亮。
  await page.evaluate(() => window.__iceAgentConsole.clearPoint());
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
  //
  // ⚠️ 判据不能是"有没有高亮" —— **讲解剧本讲完是留着高亮的**（刻意的），
  // 所以点下去那一刻 `diagramPointedId()` 就已经非空了，那个等待会**立刻返回**，
  // 拍到的是还没推镜头、还停在上一个高亮上的中间态（上一版就是这么拍到一张全貌图的）。
  // 判据必须是"高亮**换到了这一拍的目标**，而且镜头推到位了"。
  const pointedBefore = await page.evaluate(() => window.__iceAgentConsole.diagramPointedId());
  // 同理用精确匹配（这一条目前没有同前缀的兄弟，但别给下一对留雷）。
  await page.getByRole('button', { name: '让图元闪烁', exact: true }).click();
  await page.waitForFunction(
    (prev) => {
      const api = window.__iceAgentConsole;
      const id = api.diagramPointedId();
      const z = api.diagramZoom();
      // 闪烁剧本第一拍点的是 ana1，档位是"单格"；两个条件都要满足，
      // 而且补间得停下来 —— 否则拍到的是推镜头到一半的画面。
      return !!id && id !== prev && Math.abs((z?.scale ?? 0) - 1.5) < 0.02 && !z?.animating;
    },
    pointedBefore,
    { timeout: 30_000 }
  );
  // 闪烁是有时限的（6 轮 × 160ms），所以**等它把高亮打上去就立刻拍**，
  // 不能等整轮跑完 —— 那时候三拍已经闪过去了。
  await waitForBlinkBright();
  await shootHighlightCloseUp('highlight');

  // ⚠️ 拍完必须**等这一轮真的跑完**再往下走：闪烁剧本还有两拍，
  //    而应用有 `if (running) return` 的护栏 —— 抢跑的下一次点击会被静默吞掉，
  //    后面就卡在 `onLayer('chart')` 上等到超时（第一版就是这么挂的）。
  await page.waitForFunction(() => window.__iceAgentConsole.getState().status === 'idle', undefined, {
    timeout: 30_000,
  });

  // ---- 1c. 改图：提标改造（拆一处、加三处）----
  // 两张对照图，都做整图适配 —— 这样"哪里少了、哪里多了"一眼能对上。
  // 同样先清高亮：对照图上有黄框就没法一眼看出"哪块是新加的"（闪烁刚点完 aer1）。
  await page.evaluate(() => window.__iceAgentConsole.fitAll());
  await page.evaluate(() => window.__iceAgentConsole.clearPoint());
  await page.waitForTimeout(400);
  await shootStage('upgrade-before');
  await chip('提标改造');
  await page.evaluate(() => window.__iceAgentConsole.fitAll());
  await page.evaluate(() => window.__iceAgentConsole.clearPoint());
  await page.waitForTimeout(400);
  await shootStage('upgrade');

  // ---- 2. 图表 + 「指着讲」（主链路）----
  await chip('看看出水 COD 的趋势');
  await onLayer('chart');
  await shoot('chart');

  // ---- 3. 流式追加：走 appendData 快路径，同一张图逐拍长数据 ----
  await chip('看看出水实时流量');
  await onLayer('chart');
  // 必须等三拍追加完（`chip` 只等到 idle，而追加的三拍都在同一个 run 里 —— 所以这里是对的）
  await shoot('streaming');

  // ---- 4. 人机回环：中断 → 表单图层（停在 waiting）----
  // 表单比一屏高（它自己会滚），所以后面几张先把视口调高，不然拍到一半就断了
  await needTall();
  await chip('给进水泵下发指令', 'waiting', 700);
  await onLayer('form');
  await shoot('form-card');

  // ---- 5. 新控件原型（10 个字段，最高的一张）----
  await chip('调整加药量');
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

  // ---- 7. 演示模式：同一份界面，**没有后端** ----
  // 这一张要证明的是"演示模式下画面跟连后端一模一样，区别只在顶栏那行徽标"。
  // 所以：另开一个干净页面走 `?demo=1`，就地问一次"这一路 transport 是什么"，
  // 再断言整个过程中**一个请求都没打到 8099** —— 截图只能看画，这两条才是证据。
  const demoPage = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 2 });
  const demoHits = [];
  const demoErrs = [];
  demoPage.on('request', (r) => {
    if (r.url().includes('8099')) demoHits.push(r.url());
  });
  demoPage.on('pageerror', (e) => demoErrs.push('pageerror: ' + e.message));
  demoPage.on('console', (m) => {
    if (m.type() === 'error') demoErrs.push('console: ' + m.text());
  });

  await demoPage.goto(BASE + '?demo=1&autoplay=0');
  await demoPage.waitForFunction(() => !!window.__iceAgentConsole?.diagramStats()?.symbols, undefined, {
    timeout: 20000,
  });
  const demoMode = await demoPage.evaluate(() => window.__iceAgentConsole.runMode());
  // 走一遍讲解，让面板里有内容 —— 空面板证明不了"它真的能跑"。
  const demoChip = demoPage.getByRole('button', { name: '看看污水处理工艺图', exact: true });
  const demoBefore = await demoPage.evaluate(() => window.__iceAgentConsole.getState().eventCount);
  await demoChip.click();
  await demoPage.waitForFunction(
    (min) => {
      const s = window.__iceAgentConsole.getState();
      return s.status === 'idle' && s.eventCount > min;
    },
    demoBefore,
    { timeout: 40000 }
  );
  await demoPage.waitForTimeout(800);
  await demoPage.locator('body').screenshot({ path: path.join(OUT, 'demo-mode.png') });
  console.log('  → demo-mode.png');
  console.log('  runMode =', demoMode, '| 打到 8099 的请求 =', demoHits.length);
  if (demoMode !== 'demo') errs.push('演示模式没生效：runMode = ' + demoMode);
  if (demoHits.length) errs.push('演示模式仍打到了后端：' + demoHits.join(', '));
  errs.push(...demoErrs);

  console.log('错误 =', errs.length ? errs : '无');
  await browser.close();
})();
