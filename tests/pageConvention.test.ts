/**
 * 应用层写法棘轮（2026-09-17 立）：**一页 = 一个类**。
 *
 * 家族口径（`ice-web-components` 的 `ICEContainer` 契约 + 各仓的示例页/页面）：
 * 页面的装配脚本里**只应该有一个类**，构造期建好、方法承载交互与布局；
 * 不出现模块级的 `function` / `let`，也不把状态摊在模块顶层。
 *
 * 本仓的"一页"就是 `src/entries/boot.ts` —— 这个工程只有一屏（绘图区铺满 + 对话面板浮着），
 * 所以入口即页面（与 `ice-game` 的 `src/home/main.ts` 同形，与 smart-water 那种
 * "宿主 + 12 页"分成两类：那边入口是宿主，页面在 `src/view/pages/`）。
 *
 * 为什么要有这条测试：`tsc` 挡不住"又写成模块级脚本"这种走回头路的写法，
 * 而那种写法一旦回来，`__iceAgentConsole` 这类"页面自己的事实"就会重新变成
 * 谁也说不清归属的全局变量。这里用一条便宜的正则守住。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const BOOT = path.resolve(__dirname, '..', 'src', 'entries', 'boot.ts');
const source = () => fs.readFileSync(BOOT, 'utf8');

describe('页面写法棘轮（一页一个类）', () => {
  it('入口就是一个页面类：恰好一个 class，且没有模块级 function / let', () => {
    const text = source();
    expect(text.match(/^class [A-Z]/gm) || []).toHaveLength(1);
    expect(text.match(/^(?:export )?(?:async )?function /gm) || []).toEqual([]);
    expect(text.match(/^(?:export )?let /gm) || []).toEqual([]);
  });

  it('文件末尾实例化那一页（页面不是"等谁来调用"的模块）', () => {
    expect(source()).toMatch(/^new AgentConsolePage\(\);$/m);
  });

  it('状态在实例上，不在模块顶层（`pendingDiagnostics` 这类边界状态也是字段）', () => {
    const text = source();
    // 顶层 const 只剩 import 与类型；可变状态一律 private 字段
    expect(text.match(/^(?:export )?const /gm) || []).toEqual([]);
    for (const name of ['pendingDiagnostics', 'failedTool', 'autoRepairUsed', 'running']) {
      expect(text).toMatch(new RegExp(`^  private ${name}\\b`, 'm'));
    }
  });

  it('调试句柄挂在页面实例上（`window.__iceAgentConsole` 的生命周期 = 这一页）', () => {
    const text = source();
    expect(text).toContain('(globalThis as any).__iceAgentConsole = {');
    // 句柄里的查询一律走 `this.stage` / `this.state`，不是模块级自由变量
    expect(text).not.toMatch(/__iceAgentConsole = \{[^}]*=> (state|stage)\b/);
  });
});
