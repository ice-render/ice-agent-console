/**
 * **transport 开关**：这一次跑远端后端，还是在浏览器里跑剧本。
 *
 * ## 为什么需要一个开关（而不是"没有后端就自动降级"）
 *
 * 演示站点（GitHub Pages / 任何静态托管）上没有后端，所以需要一条"不需要服务端也能演"的路。
 * 但**自动降级**是个坏主意：它会掩盖真问题 —— API 地址打错、后端挂了、CORS 配错，
 * 全都静默变成"演示模式"，你还以为一切正常。而且每次都要先等 fetch 失败才有反应。
 *
 * 所以模式是**显式**的：构建期定默认值，运行期可用 URL 参数覆盖。
 *
 * ## 两级优先
 *
 * | 来源 | 什么时候用 | 怎么表达 |
 * |---|---|---|
 * | 构建期默认 | 出演示站点/POC 用的产物 | `npm run build:demo`（webpack `--env demo`） |
 * | 运行期覆盖 | 同一份产物里临时切回去 | `?demo=0` / `?demo=1` |
 *
 * 普通 `npm run build` 的构建期默认是 `server`，所以**行为与加这个开关之前完全一致**。
 *
 * 用 `?demo=` 而不是自造一个 `globalThis` 覆盖口：这个工程已经有 `?theme=dark`
 * 的先例（`src/domain/theme.ts`），而且 URL 参数对"分享一个演示链接"这件事更自然 ——
 * 链接本身就带上了模式。
 */
import { runAgent } from './client';
import { runAgentLocally } from './local-agent';
import type { RunTransport } from './run-input';

export type RunMode = 'server' | 'demo';

/**
 * 构建期注入的常量。`npm run build:demo` 时为 `true`，否则 `false`。
 *
 * ⚠️ `typeof` 那道判断**不能省**：这个常量由 webpack 的 DefinePlugin 注入，
 * 而单测跑在 jest 里、**没有 DefinePlugin** —— 直接写 `__ICE_DEMO__ === true`
 * 会在 import 这个模块的那一刻抛 `ReferenceError`（不是运行时才炸，是模块加载就炸）。
 *
 * `typeof` 对未声明的标识符是安全的，且 DefinePlugin 会把 `typeof __ICE_DEMO__`
 * 一起替换成 `typeof true` / `typeof false`，两边都不出错。
 */
declare const __ICE_DEMO__: boolean;
export const BUILD_DEFAULT_DEMO: boolean =
  typeof __ICE_DEMO__ !== 'undefined' && __ICE_DEMO__ === true;

/**
 * 判定这次跑哪种模式。**纯函数**（`search` 从外面传进来），所以优先级能被穷举测掉。
 *
 * 非法值（`?demo=whatever`）**落回构建期默认**而不是报错 —— URL 参数是给人和分享链接用的，
 * 手抖打错一个参数不该让页面白屏。这跟 `?theme=` 的处理口径一致。
 */
export function resolveRunMode(search: string, buildDefaultDemo: boolean = BUILD_DEFAULT_DEMO): RunMode {
  const wanted = new URLSearchParams(search).get('demo');
  if (wanted === '1' || wanted === 'true') return 'demo';
  if (wanted === '0' || wanted === 'false') return 'server';
  return buildDefaultDemo ? 'demo' : 'server';
}

/** 按模式取 transport。 */
export function pickTransport(mode: RunMode): RunTransport {
  return mode === 'demo' ? runAgentLocally : runAgent;
}
