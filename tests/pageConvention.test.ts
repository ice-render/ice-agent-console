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

/**
 * 类体的成员序列：`S` 静态字段 / `F` 实例字段 / `C` 构造函数 / `A` 访问器 /
 * `T` 静态方法 / `M` 实例方法。
 *
 * 只看**类体这一层**（缩进回到 0 的行），所以方法体里的东西不会被算进来；
 * 注释行整行跳过（注释里常有 `private xxx` 这种字样的说明）。
 */
const memberSequence = (classBody: string): string => {
  const kinds: string[] = [];
  let depth = 0;
  for (const line of classBody.split('\n')) {
    const t = line.trim();
    if (depth === 0 && t && !/^(\*|\/\/|\/\*)/.test(t)) {
      const isCtor = /^(?:public |protected |private )?constructor\s*\(/.test(t);
      const isStatic = /^(?:public |protected |private )?static\b/.test(t);
      const isAccessor = /^(?:public |private |protected )?(?:get|set)\s+[A-Za-z_$]/.test(t);
      const isCall = /\b(if|for|while|switch|catch|return|new|super|await|void|typeof)\b/.test(
        t.split('(')[0]
      );
      const mods = '(?:(?:public|private|protected|readonly|declare|abstract|override|static|async|\\*)\\s+)*';
      const isMethod =
        !isCtor && !isAccessor && !isCall && /\(/.test(t) && new RegExp(`^${mods}[A-Za-z_$#][\\w$]*(?:\\s*<[^>]*>)?\\s*\\(`).test(t);
      const isField =
        !isCtor && !isAccessor && !isMethod && new RegExp(`^${mods}[A-Za-z_$#][\\w$]*(?:!|\\?)?\\s*(?::[^=;]*)?(?:=|;)`).test(t);
      if (isCtor) kinds.push('C');
      else if (isField) kinds.push(isStatic ? 'S' : 'F');
      else if (isAccessor) kinds.push('A');
      else if (isMethod) kinds.push(isStatic ? 'T' : 'M');
    }
    depth += (line.match(/[{([]/g) || []).length - (line.match(/[})\]]/g) || []).length;
    if (depth < 0) depth = 0;
  }
  return kinds.join('');
};

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

/**
 * 成员顺序棘轮（2026-09-17 定，全家族同口径）。
 *
 * 契约：`static 常量/字段 → 实例字段 → 构造函数 → 访问器 → static 方法 → 实例方法`
 * —— 也就是这个正则：`S*F*C*A*T*M*`。
 *
 * 为什么只到这一层：Google Java Style §3.4.2 明确说 class 成员"**没有唯一正确的配方**"，
 * 要求的是每种顺序都讲得通、维护者能解释；Google 的 TypeScript 指南对顺序**完全沉默**
 * （全文 "ordering" 出现 0 次，只要求构造函数上下各留一个空行）。所以 public/private
 * 谁先谁后、同组内谁先谁后，都留给作者判断，这里只钉"讲得通"的骨架。
 *
 * ⚠️ 挪位置时要知道 TS 跟 Java 不一样：**方法随便挪**（方法在类定义时就全部装好，
 * 与文本顺序无关）；**字段的声明顺序是有语义的**（初始化按声明顺序执行，还影响 V8 的
 * class shape），所以挪字段必须逐个确认初始化表达式互不依赖。
 */
describe('成员顺序棘轮（static 常量 → 实例字段 → 构造函数 → 方法）', () => {
  it('AgentConsolePage 的成员序列符合 S*F*C*A*T*M*', () => {
    const text = source();
    const body = text.slice(text.indexOf('class AgentConsolePage {')).split('\n').slice(1).join('\n');
    const seq = memberSequence(body);
    expect(seq).toMatch(/^S*F*C*A*T*M*$/);
    // 自检：正则没扫到东西就得先修这条测试（否则它会永远绿）
    expect(seq.length).toBeGreaterThan(30);
  });
});
