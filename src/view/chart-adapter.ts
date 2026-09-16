/**
 * 协议 ↔ ICE 的适配层（命令式的那一半）。
 *
 * 纯判断逻辑在 `src/domain/ice/option-mapping.ts`，这里只做"动手"的事：
 * 建图表实例、挂监听、重排尺寸。这样拆分是因为前者能在 node 里穷举测试，
 * 后者必须起画布——把两者混在一起，前者就跟着变成不可测了。
 *
 * 两处关键翻译：
 *
 * 1. **快照 → `setOption`（不是 `renderChartDsl`）**
 *    `renderChartDsl` 每次都 `createChart`，用在流式更新上会不停泄漏图表实例，
 *    而且挂在上面的监听会随之丢失（症状是"第 N 次更新后点了没反应"）。
 *    所以这里自己拆成 `validate → compile → setOption`，实例只建一次。
 *
 * 2. **增量 → `appendData` 快路径，判不了就全量**（判断在 option-mapping.ts）
 */
import { createChart, type ChartOption, type ICEChart } from '@damoqiongqiu/ice-chart';
import { compileChartDsl, formatDiagnostics, validateChartDsl } from '@damoqiongqiu/ice-chart-dsl';
import { planAppend, withRoundTripInteractions } from '../domain/ice/option-mapping';
import { applyThemeToIce } from '../domain/theme';

export interface ChartInteractionPayload {
  seriesId?: string;
  seriesName?: string;
  /** 数据下标。 */
  dataIndex?: number;
  /** x 原始值（类目轴是类目名，数值轴是数字）。 */
  xValue?: any;
  value?: number | null;
}

/** 上行通道：用户在图上做的事，回传给应用层去触发新一轮 run。 */
export interface InteractionHandlers {
  onItemClick?: (payload: ChartInteractionPayload) => void;
  /** `BrushRange`：`{ x?: [any, any]; y?: [number, number] }`。 */
  onBrushEnd?: (range: { x?: [any, any]; y?: [number, number] }) => void;
}

export interface MountResult {
  ok: boolean;
  /** 校验没通过时的结构化诊断（也用来回灌给 agent 做自修复）。 */
  diagnostics: string | null;
}

export class ChartAdapter {
  private chart: ICEChart | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly handlers: InteractionHandlers = {},
    private readonly cssHeight = 300
  ) {}

  /**
   * 渲染一份 DSL。已经渲染过就复用同一个图表实例。
   *
   * 校验不通过时**不画**：与其画一张空图让人猜，不如把诊断摆出来。
   * 这也正是 ice-chart-dsl 存在的意义——它的 validate 是给 agent 做自修复用的。
   */
  mount(dsl: any): MountResult {
    const result = validateChartDsl(dsl);
    if (!result.valid) {
      return { ok: false, diagnostics: formatDiagnostics(result) };
    }

    const compiled = compileChartDsl(dsl) as ChartOption;
    const option = withRoundTripInteractions(compiled);

    if (this.chart) {
      this.chart.setOption(option, { preserveView: true });
    } else {
      this.chart = createChart(this.canvas, option, {
        dpr: (globalThis as any).devicePixelRatio || 1,
      });
      // `createChart` 内部自己 `new ICE()`（这是上游缺口第 7 条），所以实例要在这里
      // 才拿得到。图表的 `theme: 'auto'` 是按**引擎主题背景色的亮度**判明暗的 ——
      // 所以这一句同时也决定了图表画成亮色还是暗色。
      applyThemeToIce((this.chart as any).ice);
      this.wireInteractions(this.chart);
      this.resize();
    }

    const warnings = result.warnings?.length ? formatDiagnostics(result) : null;
    return { ok: true, diagnostics: warnings };
  }

  /** 追加数据行。返回 false 表示这批行走不了快路径，调用方应该全量重绘。 */
  appendRows(rows: any[][]): boolean {
    if (!this.chart) return false;
    const plan = planAppend(this.chart.getOption(), rows);
    if (!plan) return false;
    for (const item of plan) {
      this.chart.appendData(item.seriesId, item.points as any);
    }
    return true;
  }

  /**
   * 「指着讲」：把高亮移到某个 x 值上。
   *
   * 这是 ICE 在这条链路上最不可替代的能力——别的图表库也能画图，
   * 但能被外部程序驱动着"指到某处、并且和文字同步"的不多。
   */
  pointAt(value: any): boolean {
    if (!this.chart) return false;
    this.chart.showHoverAtValue(value);
    return true;
  }

  clearPoint(): void {
    this.chart?.clearHover();
  }

  /**
   * 按容器重排。画布宽度是流式的（以前跟着卡片宽度走，现在跟着绘图区走）。
   *
   * 显式传尺寸是给"容器自己量不准"的场景留的口子：布局反转之后图表宿主是
   * 绝对定位铺满的一块，`parentElement.clientWidth` 有时是 0（还没进 DOM 时），
   * 那时由舞台上把实测值递进来。
   */
  resize(cssWidth?: number, cssHeight?: number): void {
    if (!this.chart) return;
    const available = cssWidth ?? this.canvas.parentElement?.clientWidth ?? 0;
    this.chart.resize(available > 0 ? available : 640, cssHeight ?? this.cssHeight);
  }

  get mounted(): boolean {
    return this.chart !== null;
  }

  destroy(): void {
    this.chart?.destroy();
    this.chart = null;
  }

  /**
   * 接上行通道。
   *
   * 图表实例只建一次，所以监听也只挂一次——这也是"不要用 `renderChartDsl`"的另一个理由：
   * 那个函数每次重建实例，挂在上面的监听会随之丢失，症状是"点了没反应"，
   * 而且往往第 N 次更新后才出现。
   */
  private wireInteractions(chart: ICEChart): void {
    if (this.handlers.onItemClick) {
      const handler = this.handlers.onItemClick;
      chart.on('item:click', (p: any) => {
        handler({
          seriesId: p?.seriesId,
          seriesName: p?.seriesName,
          dataIndex: p?.dataIndex,
          xValue: p?.xValue,
          value: p?.value,
        });
      });
    }
    if (this.handlers.onBrushEnd) {
      const handler = this.handlers.onBrushEnd;
      chart.on('brush:end', (range: any) => {
        if (range) handler(range);
      });
    }
  }
}
