/**
 * 卡片里的**第二块画布**：用 `ice-web-components` 画的控件条。
 *
 * 它跟图表是**两个独立的 ICE 实例、两张独立的 canvas**（引擎的模型就是「一层 = 一个实例
 * + 一张画布」），并排在同一个卡片里：图表在上、控件条在下，互不重叠。
 *
 * 为什么不在图表那张画布上直接画控件：`ice-chart` 内部自己 `new ICE()`，不接受外部实例；
 * 硬塞只能走 `addMark`，而那是**按数据坐标**摆位的槽位（适合"锚在异常点上的浮动按钮"），
 * 不适合"卡片底部一条控件栏"。两种需求，两个层。
 *
 * 控件条用 canvas 画而不是真 DOM `<button>`，是因为这里要试的正是
 * "canvas 控件层能不能跟图表共存" —— 顺带拿到同一套主题（`iceUIManager` 一处切换两边都变）。
 * 代价要说清楚：canvas 控件没有 DOM 的可访问性、输入法、Cmd+F。**聊天区那部分仍然是真 DOM**，
 * 分界线没变：DOM 管外壳，canvas 管卡片内容。
 */
import { ICE } from 'ice-render';
import { ICEButton } from 'ice-web-components';
import { Layer } from '../domain/ice/layer';

export interface WidgetAction {
  id: string;
  text: string;
  variant?: 'primary' | 'default' | 'text' | 'link';
}

export interface WidgetLayerOptions {
  /** 这一层的高度（CSS 像素）。控件在这个高度里垂直居中。 */
  height?: number;
  /** 点某个控件时回调。 */
  onAction: (id: string) => void;
}

const BUTTON_HEIGHT = 32;
const GAP = 8;
const PADDING_X = 0;

export class WidgetLayer {
  readonly canvas: HTMLCanvasElement;
  readonly layer: Layer;

  private readonly ice: ICE;
  private readonly height: number;
  private readonly layout: Array<{
    id: string;
    button: ICEButton;
    left: number;
    top: number;
    width: number;
    height: number;
  }> = [];

  constructor(actions: WidgetAction[], options: WidgetLayerOptions) {
    this.height = options.height ?? 48;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'widget-canvas';

    this.ice = new ICE();
    this.ice.init(this.canvas, { dpr: (globalThis as any).devicePixelRatio || 1 });

    this.layer = new Layer('widgets', this.canvas, this.ice);
    this.build(actions, options.onAction);
  }

  /** 按卡片可用宽度对齐这一层。返回尺寸是否真的变了。 */
  fit(cssWidth: number): boolean {
    return this.layer.fit(cssWidth, this.height);
  }

  /**
   * 各按钮在本画布内的矩形（CSS 像素）。
   *
   * **canvas 里没有 DOM 目标可定位** —— 想点中某个按钮，只能知道它画在哪。
   * 这个查询是给调试和 e2e 用的：不暴露它的话，e2e 就得写死像素偏移，
   * 一改文案（按钮宽度是按字数算的）就全错位。
   */
  buttonRects(): Array<{ id: string; left: number; top: number; width: number; height: number }> {
    return this.layout.map(({ id, left, top, width, height }) => ({ id, left, top, width, height }));
  }

  destroy(): void {
    this.layout.length = 0;
    this.layer.destroy();
  }

  private build(actions: WidgetAction[], onAction: (id: string) => void): void {
    const top = Math.round((this.height - BUTTON_HEIGHT) / 2);
    let left = PADDING_X;

    for (const action of actions) {
      // 没有布局器就按文字宽度估个尺寸：控件条是一行固定高度的小东西，
      // 为它引一套布局还不如直接算。
      const width = Math.max(84, action.text.length * 14 + 28);
      const button = new ICEButton({
        left,
        top,
        width,
        height: BUTTON_HEIGHT,
        text: action.text,
        variant: action.variant || 'default',
      });
      button.on('click', () => onAction(action.id));
      this.ice.addChild(button);
      this.layout.push({ id: action.id, button, left, top, width, height: BUTTON_HEIGHT });
      left += width + GAP;
    }
  }
}
