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
import { applyThemeToIce } from '../domain/theme';

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
      // 把卡片能给的宽度传下去 —— 表单多宽取决于它被放哪儿，而 DSL 不知道这件事。
      // 不传的话它会用 `dsl.width ?? 360`，在 896 宽的卡片里右边会空掉一大片（实测 74%）。
      width: cssWidth,
      onSubmit: (values) => options.onSubmit(values),
    });
    // 表单层这个 ICE 实例是 DSL 内部建的，从 `result.ice` 拿到再对齐主题 ——
    // 否则表单控件会是亮色主题（库的主题在构造时读一次，这里是构造之后的第一时间）
    applyThemeToIce(this.result.ice);
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
    // 画布尺寸与"表单内容的对齐宽度"是两件事，两个都要调
    this.result.setWidth(width);
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

  /**
   * 各字段当前**画出来的文字**（调试 / e2e 用）。
   *
   * 为什么需要它："占位文案到底有没有画出来"这件事在 canvas 上没法用 DOM 断言，
   * 用像素也说不清（浅灰的抗锯齿会被误判）。而 `getFieldText()` 正是组件用来画字段的
   * 那个值，所以问它最直接。
   *
   * 取值器**有两个名字**，按组件而异（库里没有统一）：
   * - `getFieldText()` —— 文本类与自动完成；
   * - `getFieldLabel()` —— 浮层类（`select` / `cascader` / `tree-select` / 日期 / 时间）。
   * 两个都试，都没有才返回 `null`。`null` 是"问不到"，不是"空字符串"，别混。
   */
  fieldTexts(): Array<{ name: string; text: string | null }> {
    const items = (this.result.compiled.form as any).getItems() as any[];
    return items.map((item) => {
      const control = item.getControl?.();
      const text =
        typeof control?.getFieldText === 'function'
          ? control.getFieldText()
          : typeof control?.getFieldLabel === 'function'
            ? control.getFieldLabel()
            : null;
      return { name: item.getName?.() ?? '', text };
    });
  }

  /** 当前各字段的值（调试 / e2e 用）。用来证明"值真的进了表单模型"。 */
  values(): Record<string, any> {
    return this.result.compiled.getValues();
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
