/**
 * 给 README 拍的截图。
 *
 * 规矩（沿用家族 README 的经验）：**2× 采集 + 按内容包围盒裁切**。
 * `#app` 自己带左右边框与最大宽度，所以对它截图就等于裁好了，不用事后算 bbox。
 *
 * 两个坑都踩过：
 * 1. **`#thread` 是滚动容器** —— 直接对 `#app` 截图只会拍到顶部（第一版拍出来的
 *    "表单卡"其实是图表卡）。所以每次拍之前先把 thread 滚到底，另外**再单独拍一张
 *    卡片的特写**（README 里用特写更清楚）。
 * 2. **不能只等 `status`**：上一轮结束时它就已经是 `idle`，等待会立刻返回，
 *    于是下一次点击落在 run 还没开始的时候 —— 而应用有 `if (running) return` 的护栏，
 *    那一次点击被静默吞掉，后面就永远等不到。判据必须是"状态对了 **且** 事件数涨过基线"。
 * 3. **比视口高的元素不能直接截**：`#thread` 是滚动容器、页头页脚是固定的，
 *    Playwright 对超高的元素会滚动拼接，结果是把固定的头尾糊进图中间。
 *    所以拍一整张卡片（比如 10 个字段的控件原型页）之前，先把视口调够高。
 *
 * 用法：先起服务（`npm run dev`），再 `node scripts/shoot-docs.cjs`。
 */
const path = require('node:path');
const fs = require('node:fs');
const dir = '/Users/felix/Windows-E-workspace/felix/ice-render/ice-agent-console';
const { chromium } = require(path.join(dir, 'node_modules/@playwright/test'));

const OUT = path.join(dir, 'docs/images');
const BASE = process.env.CONSOLE_URL || 'http://127.0.0.1:8100/';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1100, height: 940 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push('console: ' + m.text());
  });

  const shoot = async (name, locator = page.locator('#app')) => {
    await locator.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log('  →', `${name}.png`);
  };

  /** 拍卡片特写用：把视口调够高，免得超高元素被滚动拼接、固定的头尾糊进图中间。 */
  const needTall = async (height = 1800) => {
    await page.setViewportSize({ width: 1100, height });
    await page.waitForTimeout(300);
  };
  const needWindow = async () => {
    await page.setViewportSize({ width: 1100, height: 940 });
    await page.waitForTimeout(300);
  };

  const toBottom = async () => {
    await page.evaluate(() => {
      const t = document.getElementById('thread');
      if (t) t.scrollTop = t.scrollHeight;
    });
    await page.waitForTimeout(250);
  };

  /** 点一个快捷按钮并等这一轮真的跑完（判据见文件头第 2 条）。 */
  const chip = async (text, status = 'idle', waitAfter = 1100) => {
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
    await toBottom();
  };

  const lastCard = () => page.locator('.card').last();

  // ---- 1. 首屏（空态）----
  await page.goto(BASE);
  await page.waitForTimeout(300);
  await shoot('empty');

  // ---- 2. 图表卡 + 「指着讲」（主图）----
  await chip('看看各渠道的月度销量');
  await shoot('hero');

  // ---- 2b. 图卡片（工艺流程图）：第三种卡片形态，也是现在最大的一张图 ----
  // 卡片比一个窗口高（画布 520 + 页头页脚），所以先调高视口再拍特写（见文件头第 3 条）。
  await needTall();
  await chip('看看污水处理工艺图');
  await shoot('water-process', lastCard());
  await needWindow();

  // ---- 3. 流式追加：走 appendData 快路径的卡片 ----
  await chip('看一下实时吞吐量');
  await shoot('streaming');

  // ---- 4. 人机回环：中断 → 表单卡（停在 waiting）----
  // 后面三张是**卡片特写**，卡片比"一个窗口高"，所以先把视口调够高（见文件头第 3 条）
  await needTall();
  await chip('要下发指令', 'waiting', 900);
  await shoot('form-card', lastCard());

  // ---- 5. 新控件原型（10 个字段，最高的一张）----
  await chip('看看新控件都能用吗');
  await shoot('showcase', lastCard());

  // ---- 6. 自修复：校验不通过的卡片 + 诊断（第一张坏卡）----
  await chip('故意画错');
  await shoot('self-repair', lastCard());
  await needWindow();

  console.log('错误 =', errs.length ? errs : '无');
  await browser.close();
})();
