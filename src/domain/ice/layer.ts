/**
 * 「层」：一块 canvas + 一个 ICE 实例，加上两件每个宿主都要重复的琐事 —— 按显示尺寸对齐、一起销毁。
 *
 * ## 为什么它这么薄
 *
 * 引擎的模型是「**一层 = 一个 ICE 实例 + 一张 canvas**」，协作原语
 * （`ICE.linkViewport()` / `setInputPassthrough()` / `composeLayersToCanvas()`）
 * 全都是**实例之间**的，不是"一个实例挂多个渲染目标"。而"把这个层的显示尺寸转交回引擎"
 * 这件事，引擎在 2.12.0 提供了 `fitCanvasToDisplaySize()` 之后也只剩一行。
 *
 * 所以应用侧剩下的真的就是这点琐事。**难的部分引擎已经做完了** ——
 * 如果这里长到几十上百行，那说明抽错了位置。
 *
 * ## 它不管什么
 *
 * 不管 DOM 的创建与定位。本工程的卡片自己建 canvas 并跟着卡片宽度走；
 * `ice-smart-water` 的"岛"是绝对定位塞进外壳挖好的洞里 ——
 * 两种宿主的定位方式完全不同，硬统一只会做出一个谁都不好用的东西。
 *
 * 也**不做**视口同步 / 输入穿透 / 导出合成：那些只在"层与层**叠加**"时才有意义。
 * 本工程卡片里的两块画布是**并排**的（图表在上、控件条在下），互不重叠，用不上。
 * 等真出现叠加场景（静态层 + 动画层、外壳 + 岛）再加，而不是先按想象抽一遍。
 */
import type { ICE } from 'ice-render';

export class Layer {
  private destroyed = false;

  constructor(
    readonly id: string,
    readonly canvas: HTMLCanvasElement,
    readonly ice: ICE
  ) {}

  /** 把这一层的显示尺寸转交给引擎。返回尺寸是否真的变了。 */
  fit(cssWidth: number, cssHeight: number): boolean {
    return this.ice.fitCanvasToDisplaySize(cssWidth, cssHeight);
  }

  /** 画布当前的设备像素尺寸。 */
  get backingSize(): { width: number; height: number } {
    return { width: this.canvas.width, height: this.canvas.height };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ice.destroy();
  }
}

/**
 * 一组层的生命周期。
 *
 * 看起来只是"循环调 destroy"，但漏掉一个的代价是实打实的：一张画布、一个 rAF 循环、
 * 一堆挂在 window 上的监听会一直留着。卡片是会被反复创建销毁的（每次 tool call 一张），
 * 漏一次就是持续泄漏。
 */
export class LayerSet {
  private layers = new Map<string, Layer>();

  add(layer: Layer): Layer {
    if (this.layers.has(layer.id)) {
      throw new Error(`[layer] id「${layer.id}」已存在`);
    }
    this.layers.set(layer.id, layer);
    return layer;
  }

  get(id: string): Layer | undefined {
    return this.layers.get(id);
  }

  ids(): string[] {
    return Array.from(this.layers.keys());
  }

  destroyAll(): void {
    for (const layer of this.layers.values()) layer.destroy();
    this.layers.clear();
  }
}
