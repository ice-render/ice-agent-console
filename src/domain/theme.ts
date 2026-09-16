/**
 * 主题：**画布里的东西与 DOM 外壳读同一份 token**。
 *
 * ## 为什么不是"给 CSS 换一套颜色"
 *
 * 这个工程的界面是**两半拼起来的**：Thread 外壳是真 DOM，卡片内容是 canvas
 * （见 README「一个刻意的分界」）。所以换主题要同时动两处，而两处各自维护一套颜色
 * 必然会漂 —— 那样试过一次：画布里的控件是 Bootstrap 深灰、外壳是另一套蓝，
 * 拼在一起像两个应用。
 *
 * 现在只有**一份 token 表**：`ice-web-components` 的 `ICEThemeTokens`。
 * - 画布那一侧交给库：`iceUIManager.setTheme()`（控件构造时取色）
 *   与 `applyThemeToEngine(ice)`（引擎自己画的那层：选中框 / 手柄 / 阴影色）；
 * - DOM 那一侧由 `applyThemeToCss()` 把同一张表写进 CSS 变量。
 *
 * ## 默认 **light**，暗色保留成可选项
 *
 * 暗色那条路是通的（控件、浮层、表单在深底上都能看，实测过 select 的下拉面板、
 * 色板、分段控制器），但**默认给 light**：库的暗色 token 是 Bootstrap 中性灰基调，
 * 层与层之间明度差很小 —— 卡片、控件、浮层容易糊在一起，看着发闷。
 * 要做得好看得动库里的暗色 token，那是另一件事（记在 docs/upstream-gaps.md 第 11 条）。
 *
 * 想再看一眼暗色：URL 上加 `?theme=dark`。留这个口子是刻意的 ——
 * "暗色到底行不行"要反复看才能真正判断，改代码再重启的成本高到没人会去做。
 *
 * ## 强调色有两个名字
 *
 * 家族品牌色是冰蓝 `#61D9FB`。它在**深底上**直接当文字色好看，在**浅底上**当文字色
 * 对比度不够（4.5:1 都不到）—— 所以拆成两个变量：
 * - `--ice` —— 填充 / 描边（两种主题都是冰蓝）；
 * - `--ice-ink` —— 当文字用的强调色（浅底上用深一档的 `#0D7EA8`，深底上就用冰蓝本身）。
 *
 * 这是"暗色不是把亮色反过来"的一个具体例子：同一个语义在不同底上要取不同的值。
 */
import {
  ICE_DARK_THEME,
  ICE_LIGHT_THEME,
  applyThemeToEngine,
  iceUIManager,
  type ICEThemeTokens,
} from 'ice-web-components';

/** 家族品牌色，与各仓 logo、示例页强调色同一个值。 */
const ICE_BLUE = '#61D9FB';
/** 浅底上当文字用的强调色（冰蓝在浅底上对比度不够，文字要深一档）。 */
const ICE_BLUE_INK_ON_LIGHT = '#0D7EA8';

export type ThemeName = 'light' | 'dark';

/** 注册名。注册进库里，`getThemeNames()` 能看到。 */
const REGISTERED: Record<ThemeName, string> = { light: 'ice-light', dark: 'ice-dark' };

/**
 * 给一套库主题打上家族补丁。
 *
 * 冰蓝很亮，所以 `primaryText`（画在主色底上的文字）要配**深字** ——
 * 两套主题都这么给。
 */
function withFamilyPrimary(tokens: ICEThemeTokens): ICEThemeTokens {
  return {
    ...tokens,
    colors: {
      ...tokens.colors,
      primary: ICE_BLUE,
      primaryHover: '#8AE6FD',
      primaryActive: '#2FB8DD',
      primaryText: '#062A33',
      primaryBorder: '#14657F',
      focusRing: 'rgba(97, 217, 251, 0.55)',
    },
  };
}

/** 两套都注册好，切的时候只是 `setTheme(name)`。 */
const THEMES: Record<ThemeName, ICEThemeTokens> = {
  light: withFamilyPrimary(ICE_LIGHT_THEME),
  dark: withFamilyPrimary(ICE_DARK_THEME),
};

/** 默认主题。改这一行就换默认 —— 但先读文件头那段"为什么默认 light"。 */
const DEFAULT_THEME: ThemeName = 'light';

let installed: ThemeName | null = null;

/** 从 URL 上读主题覆盖：`?theme=dark` / `?theme=light`。 */
function themeFromUrl(): ThemeName | null {
  try {
    const v = new URLSearchParams(location.search).get('theme');
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null;
  }
}

/** 当前生效的主题名。 */
export function currentTheme(): ThemeName {
  return installed ?? DEFAULT_THEME;
}

/**
 * 装主题。**必须在任何组件 / ICE 实例被构造之前调**。
 *
 * 库的注释写得很明确：「主题在组件构造时读取一次，要热切换就重建组件」。
 * 所以本工程是"启动即定死" —— 卡片是按需创建的，装完主题之后建出来的都在同一套里。
 */
export function installTheme(): ThemeName {
  const name: ThemeName = themeFromUrl() ?? DEFAULT_THEME;
  iceUIManager.registerTheme(REGISTERED.light, THEMES.light);
  iceUIManager.registerTheme(REGISTERED.dark, THEMES.dark);
  iceUIManager.setTheme(REGISTERED[name]);
  installed = name;
  applyThemeToCss();
  return name;
}

/**
 * 把一个 ICE 实例对齐到当前主题。
 *
 * 图表的 `theme: 'auto'` 是按**引擎主题背景色的亮度**判明暗的，所以这一句同时也
 * 决定了图表画成亮色还是暗色 —— 卡片里那三块画布（图表 / 控件条 / 表单）都要调。
 */
export function applyThemeToIce(ice: any): void {
  if (!ice) return;
  applyThemeToEngine(ice, THEMES[currentTheme()]);
}

/**
 * **库的 token 表里没有的那几个概念**，以及它们在两套主题下各取什么值。
 *
 * 为什么要有这一块：token 表里没有"代码块配色""内凹面"这些，硬凑一个相近的 token
 * 更糟（读的人以为它是从主题来的）。所以把它们**集中在这里、显式按主题给**，
 * 而不是散在样式表里 —— 至少改的时候知道要改哪。
 */
const LOCAL_TOKENS: Record<ThemeName, Record<string, string>> = {
  light: {
    // 半成品 DSL 的代码块：浅色页面上故意用深底（第一版就是这么定的，保留）
    '--code-bg': '#0F172A',
    '--code-fg': '#B6E3F5',
    // 浮层：对话面板 / 控件条 / 表单压在"画着图的那一层"上，必须跟它能分开。
    // token 表里没有"浮层"这个概念，所以在这里显式按主题给：
    // 亮色主题的 `surface` 与 `elevated` 都是纯白，直接拿来当浮层底会跟绘图区糊在一起，
    // 只能靠边框 + 阴影拉开 —— 这两行就是那份差值。
    '--overlay-bg': '#FFFFFF',
    '--overlay-line': '#D5DBE1',
    '--overlay-shadow': '0 8px 28px rgba(15, 23, 42, 0.16)',
  },
  dark: {
    '--code-bg': '#101418',
    '--code-fg': '#9FDCF2',
    // 深底上反过来：浮层要**比绘图区亮一档**才浮得起来，阴影反而几乎不可见（深底没影子）
    '--overlay-bg': '#1B2027',
    '--overlay-line': '#2C333C',
    '--overlay-shadow': '0 8px 28px rgba(0, 0, 0, 0.5)',
  },
};

/**
 * 把主题写进 CSS 变量 —— **DOM 外壳的颜色从同一张表里读**，不另抄一套。
 *
 * 少一次手抄就少一处漂移：改了 token，画布与外壳一起变。
 */
function applyThemeToCss(): void {
  const name = currentTheme();
  const c = iceUIManager.getTheme().colors as any;
  const root = document.documentElement;
  const set = (prop: string, value: string | undefined) => {
    if (value) root.style.setProperty(prop, value);
  };

  root.dataset.theme = name;
  // 底与面
  set('--bg', c.background);
  set('--panel', c.surface);
  set('--elevated', c.elevated ?? c.surface);
  set('--line', c.border);
  // 文字
  set('--text', c.text);
  set('--muted', c.textSecondary);
  set('--hint', c.textTertiary ?? c.textSecondary);
  // 强调：填充用一种、当文字用另一种（见文件头那段）
  set('--ice', c.primary);
  set('--ice-ink', name === 'light' ? ICE_BLUE_INK_ON_LIGHT : c.primary);
  set('--ice-soft', c.primaryBg);
  set('--ice-line', c.primaryBorder);
  // 语义
  set('--ok', c.success);
  set('--warn', c.warning);
  set('--err', c.error);
  set('--warn-bg', c.warningBg);
  set('--warn-line', c.warningBorder);
  set('--err-bg', c.errorBg);
  set('--err-line', c.errorBorder);
  // 气泡：主色软底给"我"，**比面板沉一档**的底给 Agent。
  //
  // 亮色主题里 `surface` 与 `elevated` 都是纯白，拿它当 Agent 气泡会跟卡片底一模一样
  // （肉眼等于没有气泡）。所以这里借 `background` —— 它在语义上就是"页面底、
  // 比面板沉一档"的那个面。token 表里没有"内凹面"这个概念，这是最接近的一个。
  set('--bubble-user', c.primaryBg);
  set('--bubble-agent', name === 'light' ? c.background : (c.elevated ?? c.surface));
  // 诊断/警告的正文色：token 表里已经按明暗给了不同的强调档位
  set('--err-text', c.errorTextEmphasis);
  set('--warn-text', c.warningTextEmphasis);
  for (const [prop, value] of Object.entries(LOCAL_TOKENS[name])) set(prop, value);
}
