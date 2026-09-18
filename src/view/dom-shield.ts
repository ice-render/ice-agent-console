/**
 * 把一块浮层"对画布透明"：指针 / 滚轮 / 点击事件就地掐掉，不再冒泡到 `window`。
 *
 * ## 为什么必须挡
 *
 * 引擎的原生监听（`DOMEventInterceptor`）挂在 `window` 上，把事件广播给**每一个** ICE 实例；
 * 唯一的过滤是"事件目标是不是**另一块 canvas**"（`DOMEventDispatcher.__isForeignCanvasTarget`）。
 * 一块盖在画布上的 `<div>` 不在过滤范围内 —— 在它上面滚一下，底下的画布会当成一次自己的
 * 滚轮缩放，而且按自己的画布矩形算坐标。
 *
 * ⚠️ **"没挡住"长什么样，实测过**（2026-09-16，像素级，拿图表图层做正反两面）：
 *
 * | | 在图表自己上悬停（对照） | 在面板上悬停（实验） |
 * |---|---|---|
 * | 摘掉这道屏蔽 | 画面变（提示框 / 高亮） | **画面也变** |
 * | 装上这道屏蔽 | 画面变 | 画面一动不动 |
 *
 * ⚠️ **这条泄漏在工艺图上量不出来**：工艺图的滚轮缩放监听直接挂在 canvas 元素上，
 * 事件目标是面板时根本到不了它。所以"在面板上滚一下，图没动"**不能**用来判断这道屏蔽
 * 有没有用 —— 它挡的是**走引擎事件总线的那类交互（悬停 / 命中）**。
 *
 * **不拦键盘**：输入框一直是这样工作的，拦了输入法就废了。
 */

export const SHIELDED_EVENTS = [
  'pointerdown',
  'pointerup',
  'pointermove',
  'pointercancel',
  'mousedown',
  'mouseup',
  'mousemove',
  'click',
  'dblclick',
  'auxclick',
  'wheel',
];

export interface ShieldOptions {
  /**
   * **放行画布上的事件**（默认 false = 全挡）。
   *
   * 给"浮层里自带一块 canvas"的场景用：`ice-chart` 的悬停 / 框选靠的是 window 级广播
   * （它自己按 `isOverCanvas()` 过滤），把卡片里 canvas 的事件也掐掉，图表就再也不响应了。
   * 但卡片自己的**非画布部分**（内边距、关闭按钮）仍然要挡 —— 那里的事件会让底下的
   * 工艺图以为"用户在点我"。
   */
  passCanvasEvents?: boolean;
}

/**
 * 在 `el` 上装屏蔽。**幂等**：重复调用只会多一层同样的监听（不会互相打架），
 * 所以调用方不必自己记"装过没有"。
 */
export function shieldFromCanvas(el: HTMLElement, options: ShieldOptions = {}): void {
  const passCanvas = options.passCanvasEvents === true;
  const stop = (event: Event) => {
    if (passCanvas) {
      const target = event.target as HTMLElement | null;
      // 只放行**画布里**的事件；其余（卡片背景 / 按钮 / 空白）一律掐掉
      if (target && typeof target.closest === 'function' && target.closest('canvas')) return;
    }
    event.stopPropagation();
  };
  for (const name of SHIELDED_EVENTS) el.addEventListener(name, stop);
}
