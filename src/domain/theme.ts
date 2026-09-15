/**
 * 主题：**画布里的东西与 DOM 外壳读同一份 token**。
 *
 * ## 为什么不是"给 CSS 换一套颜色"
 *
 * 这个工程的界面是**两半拼起来的**：Thread 外壳是真 DOM，卡片内容是 canvas
 * （见 README「一个刻意的分界」）。所以"改成暗色"要同时动两处，而两处各自维护一套颜色
 * 必然会漂 —— 第一版就是那样：画布里的控件是 Bootstrap 深灰、外壳的冰蓝强调色，
 * 拼在一起像两个应用。
 *
 * 现在只有**一份 token 表**：`ice-web-components` 的 `ICEThemeTokens`。
 * - 画布那一侧交给库：`iceUIManager.setTheme()`（控件构造时取色）
 *   与 `applyThemeToEngine(ice)`（引擎自己画的那层：选中框 / 手柄 / 阴影色）；
 * - DOM 那一侧由 `applyThemeToCss()` 把同一张表写进 CSS 变量。
 *
 * ## 为什么不用库内置的 `dark`
 *
 * 库内置的 `ICE_DARK_THEME` 是 Bootstrap 中性灰基调，主色是 `#0d6efd`（Bootstrap 蓝）。
 * 而 ICE 家族的品牌色是冰蓝 `#61D9FB`（见各仓 logo 与 README 的品牌基线）。
 * 所以这里**在它之上打一层补丁**，把 primary 一族换成冰蓝 —— 深底上用冰蓝比
 * Bootstrap 蓝亮得多，也更像"同一个产品"。
 */
import { ICE_DARK_THEME, applyThemeToEngine, iceUIManager, type ICEThemeTokens } from 'ice-web-components';

/** 家族品牌色，与各仓 logo、示例页强调色同一个值。 */
const ICE_BLUE = '#61D9FB';

/** 主题名。注册进库里，`getThemeNames()` 能看到它。 */
export const THEME_NAME = 'ice-dark';

/**
 * 冰蓝一族。
 *
 * `primaryText` 是**画在主色底上的文字** —— 深色主色配浅色字，浅色主色配深色字。
 * 冰蓝很亮，所以要配深字（`#062A33`），这跟亮色主题里的处理正好相反。
 */
const FAMILY_PRIMARY = {
  primary: ICE_BLUE,
  primaryHover: '#8AE6FD',
  primaryActive: '#2FB8DD',
  primaryText: '#062A33',
  primaryBg: '#04222B',
  primaryBorder: '#14657F',
  focusRing: 'rgba(97, 217, 251, 0.55)',
};

/**
 * 家族暗色主题 = 库的暗色主题 + 冰蓝主色。
 *
 * `colors` 是浅合并，`window`（Windows 风格窗口的标题栏配色）不动 —— 这个工程里
 * 用不到 `ICEWindow`。
 */
export const ICE_DARK_FAMILY_THEME: ICEThemeTokens = {
  ...ICE_DARK_THEME,
  colors: { ...ICE_DARK_THEME.colors, ...FAMILY_PRIMARY },
};

let installed = false;

/**
 * 装主题。**必须在任何组件 / ICE 实例被构造之前调**。
 *
 * 库的注释写得很明确：「主题在组件构造时读取一次，要热切换就重建组件」。
 * 本工程的做法是"启动即定死" —— 卡片是按需创建的，装完主题之后建出来的都在暗色里。
 * 没做成运行时切换的开关**不是偷懒**：切主题要重建所有卡片里的组件树，
 * 而卡片里还跑着 rAF、事件监听与流式更新，重建的代价与风险都不小；
 * 等真的有人要切换时再做，那时应该做的是"重建整条 thread"。
 */
export function installTheme(): void {
  if (installed) return;
  installed = true;
  iceUIManager.registerTheme(THEME_NAME, ICE_DARK_FAMILY_THEME);
  iceUIManager.setTheme(THEME_NAME);
  applyThemeToCss();
}

/**
 * 把一个 ICE 实例对齐到当前主题。
 *
 * 图表的 `theme: 'auto'` 是按**引擎主题背景色的亮度**判明暗的，所以这一句同时也
 * 决定了图表画成亮色还是暗色 —— 卡片里那三块画布（图表 / 控件条 / 表单）都要调。
 */
export function applyThemeToIce(ice: any): void {
  if (!ice) return;
  applyThemeToEngine(ice, ICE_DARK_FAMILY_THEME);
}

/**
 * 把主题写进 CSS 变量 —— **DOM 外壳的颜色从同一张表里读**，不另抄一套。
 *
 * 少一次手抄就少一处漂移：改了 token，画布与外壳一起变。
 */
function applyThemeToCss(): void {
  const c = iceUIManager.getTheme().colors;
  const root = document.documentElement;
  const set = (name: string, value: string | undefined) => {
    if (value) root.style.setProperty(name, value);
  };

  // 底与面
  set('--bg', c.background);
  set('--panel', c.surface);
  set('--elevated', (c as any).elevated ?? c.surface);
  set('--line', c.border);
  // 文字
  set('--text', c.text);
  set('--muted', c.textSecondary);
  set('--hint', (c as any).textTertiary ?? c.textSecondary);
  // 强调
  set('--ice', c.primary);
  set('--ice-soft', (c as any).primaryBg);
  set('--ice-line', (c as any).primaryBorder);
  // 语义
  set('--ok', c.success);
  set('--warn', c.warning);
  set('--err', c.error);
  set('--warn-bg', (c as any).warningBg);
  set('--warn-line', (c as any).warningBorder);
  set('--err-bg', (c as any).errorBg);
  set('--err-line', (c as any).errorBorder);
  // 气泡：主色系给"我"，抬升面给 Agent
  set('--bubble-user', (c as any).primaryBg);
  set('--bubble-agent', (c as any).elevated ?? c.surface);
}
