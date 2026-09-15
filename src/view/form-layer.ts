/**
 * 卡片里的**表单层**：把一份表单 DSL 画到自己的 canvas 上。
 *
 * 用的是 `ice-web-components-dsl` 的 `renderFormDsl()` —— 它内部自己 `new ICE()`，
 * 所以这里跟图表层一样是**独立的第二个 ICE 实例**（引擎的模型：「一层 = 一个实例 + 一张画布」）。
 *
 * 这一步补上的是之前识别出的那个缺口：**卡片原先只能承载图表**。
 * 现在按 tool 名分派 —— `render_chart` 出图表、`collect_input` 出表单 ——
 * 而"一张卡片 = 一次 tool call"这个粒度让这件事不需要动归约器与时间线。
 */
import { renderFormDsl, type RenderFormDslResult } from 'ice-web-components-dsl';
import { Layer } from '../domain/ice/layer';

export interface FormLayerOptions {
  /** 用户提交且**校验通过**时回调。 */
  onSubmit: (values: Record<string, any>) => void;
  /** 渲染前先看一眼诊断（校验不过时用来展示原因）。 */
  onDiagnostics?: (text: string | null) => void;
}

/** 渲染时先给一个宽松高度，量完再收紧。 */
const PROBE_HEIGHT = 720;
const MIN_HEIGHT = 160;

export class FormLayer {
  readonly canvas: HTMLCanvasElement;
  readonly layer: Layer;

  private readonly result: RenderFormDslResult;
  private readonly cssWidth: number;

  constructor(dsl: any, cssWidth: number, options: FormLayerOptions) {
    this.cssWidth = cssWidth;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'form-canvas';

    this.result = renderFormDsl(this.canvas, dsl, {
      onSubmit: (values) => options.onSubmit(values),
    });
    this.layer = new Layer('form', this.canvas, this.result.ice);

    if (options.onDiagnostics) {
      const { errors, warnings } = this.result.diagnostics;
      const text = [...errors, ...warnings].map((d) => `[${d.severity === 'error' ? '错误' : '警告'}] ${d.message}`).join('\n');
      options.onDiagnostics(text || null);
    }
  }

  /**
   * 按卡片可用宽度对齐这一层，并把高度收紧到内容实际需要的高度。
   *
   * 高度为什么要量而不是算：表单高度取决于 `ICEFormItem` 的标签行高、错误行高、
   * 控件高度与间距 —— 在应用层重算一遍这些等于把上游的排版逻辑抄一份，
   * 上游一改就错。所以先给一个宽松高度让它排一次，量完再用引擎的
   * `fitCanvasToDisplaySize()` 收紧。
   */
  fit(cssWidth: number): void {
    const width = cssWidth > 0 ? cssWidth : this.cssWidth;
    this.result.resize(width, PROBE_HEIGHT);

    const measured = this.result.measureContentHeight();
    const height = measured > 0 ? Math.max(MIN_HEIGHT, Math.ceil(measured) + 24) : PROBE_HEIGHT;
    this.result.resize(width, height);
  }

  /**
   * 提交按钮在画布内的矩形（CSS 像素）。
   *
   * **canvas 里没有 DOM 目标可定位** —— e2e 要点中它就得知道它画在哪。
   * 引擎的坐标语义就是 CSS 像素，所以返回值直接可加在画布的页面矩形上。
   */
  submitRect(): { left: number; top: number; width: number; height: number } | null {
    const button = this.result.compiled.submitButton;
    if (!button) return null;
    const origin = (button.state as any).absoluteOrigin || (button.state as any).localOrigin;
    if (!origin) return null;
    return { left: origin[0], top: origin[1], width: button.state.width, height: button.state.height };
  }

  /** 批量写入字段值（调试 / e2e 用：canvas 表单没法用 DOM 填）。 */
  setValues(values: Record<string, any>): void {
    this.result.compiled.setValues(values);
  }

  /** 已提交过就不再允许重复提交（表单模型里也拦了一层，这是界面侧的终态）。 */
  markSubmitted(): void {
    const button = this.result.compiled.submitButton;
    if (button) {
      button.setEnabled(false);
      button.setText?.('已提交');
    }
  }

  destroy(): void {
    this.result.destroy();
  }
}
