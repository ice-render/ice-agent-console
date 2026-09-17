/**
 * DOM 半的主题契约：`<html data-ice-theme>` 的值是**注册名**，不是 `light`/`dark` 这两个字面量。
 *
 * 为什么要有这条：本工程注册的主题叫 `ice-light` / `ice-dark`（刻意加前缀，避免与库内置的
 * `light` / `dark` 撞名），而 `public/index.html` 里那条 `color-scheme` 规则**按值匹配**。
 * 一旦把选择器写成 `[data-ice-theme='dark']`，它永远不命中 —— 而"滚动条还是亮的"没有任何测试会红，
 * 只有人眼看出来。这条把"选择器的后缀必须命中注册名"钉住。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const HTML = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');

/** 与 `src/domain/theme.ts` 里的 `REGISTERED` 同源：这里只取后缀，避免两处各写一份前缀。 */
const DARK_THEME_NAME = 'ice-dark';

describe('DOM 半的主题桥', () => {
  it('color-scheme 的选择器能命中注册名（不是写死的 light/dark 字面量）', () => {
    const selectors = [...HTML.matchAll(/html\[data-ice-theme([^\]]*)\]/g)].map((m) => m[1]);
    // ⚠️ 阵列断言而不是 `expect(x, '消息')` —— 本仓 jest 版本 expect 只吃一个参数（家族里记过这条）
    expect({ 规则数: selectors.length > 0 }).toEqual({ 规则数: true });

    /**
     * 选择器里的匹配有两种写法，**都得认**：
     * - `[data-ice-theme='ice-dark']`（全等，写全注册名）；
     * - `[data-ice-theme$='dark']`（后缀 —— 推荐的写法，注册名换前缀也不用改 CSS）。
     * 只按 `=` 取值的写法会把 `$=` 误判成"值就是 dark"，从而**假红**（这条测试第一版就是这么错的）。
     */
    const hitsDark = selectors.some((sel) => {
      const m = sel.match(/([$*^]?=)\s*(['"])([^'"]+)\2/);
      if (!m) return false;
      const [, op, , value] = m;
      if (op === '=') return value === DARK_THEME_NAME;
      if (op === '$=') return DARK_THEME_NAME.endsWith(value);
      if (op === '^=') return DARK_THEME_NAME.startsWith(value);
      return DARK_THEME_NAME.includes(value); // *=
    });
    expect({ 命中暗色注册名: hitsDark }).toEqual({ 命中暗色注册名: true });
  });
});
