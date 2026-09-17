/**
 * 取色来源棘轮（2026-09-17 立）：**界面色只有两个合法出处。**
 *
 * 这个工程的界面是两半：DOM 对话面板（读 CSS 变量）+ canvas 绘图区（读组件库 token）。
 * 于是"颜色从哪来"只有两条正路：
 *
 * 1. **`src/domain/theme.ts`** —— 主题的唯一事实来源（家族品牌色 + 两套 token 补丁 + 局部 token，
 *    再经 `applyThemeToCss()` 写成 CSS 变量、经 `applyThemeToEngine()` 打给每个 ICE 实例）；
 * 2. **组件库的 token**（画布那半）。
 *
 * 任何**别处**写死的十六进制色值都是"第三套来源" —— 它不会跟着换主题走，
 * 而且不会有任何测试变红（2026-09-17 在 `ice-smart-water` 就是这么漏了 12 处界面色，
 * 靠人工 grep 才挖出来）。
 *
 * 豁免只有两个文件，且都是**语义色不是界面色**：主题定义本身、以及"指着讲"的高亮黄
 * （刻意不用品牌冰蓝 —— 图纸本身就是蓝的，给个蓝框等于没标）。
 */
import { test, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.resolve(__dirname, '..', 'src');

/** 允许出现写死色值的文件（**只减不增**），每条都写清为什么它不是"界面色"。 */
const EXEMPT: Record<string, string> = {
  'domain/theme.ts': '主题定义本身：家族品牌色 + 浅/深两套 token 补丁 + 局部 token（代码块 / 浮层）',
  'view/diagram-layer.ts': '「指着讲」的高亮黄（语义标记，刻意不用品牌冰蓝；见该文件里的注释）',
};

/** 剥掉注释（文档里常引用色值讲历史），保留字符串/模板里的色值（那是真代码）。 */
function stripComments(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const c2 = source[i + 1];
    if (c === '/' && c2 === '/') {
      let j = i;
      while (j < source.length && source[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === c) break;
        j++;
      }
      i = Math.min(j + 1, source.length);
      continue;
    }
    i++;
  }
  return out.join('');
}

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
};

const hexOf = (file: string): string[] =>
  [...new Set(stripComments(fs.readFileSync(file, 'utf8')).match(/#[0-9a-fA-F]{3,8}\b/g) || [])];

describe('取色来源棘轮（界面色只能来自主题定义或组件库 token）', () => {
  test('没有第三套颜色来源', () => {
    const bad: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (EXEMPT[rel]) continue;
      const colors = hexOf(file);
      if (colors.length) bad.push(`${rel}: ${colors.join(', ')}`);
    }
    expect(bad).toEqual([]);
  });

  test('豁免清单没有过期条目（文件没色值了要删掉，且必须写理由）', () => {
    const stale: string[] = [];
    for (const [rel, reason] of Object.entries(EXEMPT)) {
      const file = path.join(SRC, rel);
      if (!fs.existsSync(file)) stale.push(`${rel}: 文件不在了`);
      else if (!hexOf(file).length) stale.push(`${rel}: 已经没有写死色值，请从豁免清单删掉`);
      if (!reason) stale.push(`${rel}: 没写理由`);
    }
    expect(stale).toEqual([]);
  });

  test('扫描口径自检：剥注释之后，注释里的色值不算（文档里常引用旧色值讲历史）', () => {
    expect(stripComments('// #ff0000\nconst a = 1;')).not.toContain('#ff0000');
    expect(stripComments("const c = '#ff0000';")).toContain('#ff0000');
  });
});
