/**
 * **工艺图层**：把一份图 DSL 画到自己的 canvas 上（`ice-entity-designer`）。
 *
 * 与另外两层的关系：图表层用 `ice-chart`、表单层用 `ice-web-components-dsl`，
 * 这一层用 `ice-entity-designer` 的 `WaterProcessDesigner`。三者都是
 * **一块 canvas + 一个 ICE 实例**（引擎的模型：「一层 = 一个实例 + 一张画布」）。
 *
 * 它在布局里的位置与另两层**不一样**：这一层在 boot 时就画好，铺满整个绘图区，
 * 之后**永不重建** —— 对话里所有动作都作用在它上面（见 `src/view/stage.ts`）。
 * 另两层是按需建、被顶掉时销毁。
 *
 * ## 只读，但可缩放平移
 *
 * 语义是"**看**图，不是**编辑**图"：符号建成 `interactive:false / draggable:false`，
 * 也不能增删。但滚轮缩放与空白处拖拽平移是**查看**手段，必须有 ——
 * 这张图的世界尺寸约 1454×985，一次看全会把 12px 的位号文字压到 6~7px，
 * 根本读不出来。所以策略是「**看一段、拖着看**」而不是"看缩略图"。
 *
 * ## 三个必须按顺序做的事（顺序是承重的，别调）
 *
 * 1. `new ICE().init(canvas, …)` —— **不 init 就没有 canvas/ctx**，`fitCanvasToDisplaySize`
 *    会返回 false，`fitViewport` 在 `canvasWidth === 0` 时直接早退，画布全白且**不报任何错**。
 * 2. **不传 dpr**（保持引擎默认 1）。`fitViewport` 是拿 `canvasWidth`（= css × dpr）算 scale 的，
 *    而渲染时视口还会再乘一次 dpr —— dpr=2 会让内容画成 2 倍大并被裁掉。
 *    要 retina 就得自己算视口，不在本次范围。`chart-adapter.ts` 传 `devicePixelRatio` 是图表的做法，
 *    **不要照抄到这里**。
 * 3. `applyThemeToIce(ice)` 必须在 `new WaterProcessDesigner(ice)` **之前**：
 *    设计器构造时会 `applyDesignerChrome(ice)`，那是**从当前引擎主题派生**外壳配色的
 *    （`designerChromeFromTheme(ice.getTheme())`）。顺序反了就会派生出引擎内置默认蓝，
 *    而不是家族品牌色 —— 两者写的是同一组 `semantic.chrome` token，后写的赢。
 *
 * 另外：`fit(cssW, cssH)` 里必须**先量尺寸、再设视口**，因为初始视口是按画布尺寸居中算的。
 *
 * ## "画布"与"可视区"是两个数
 *
 * 画布铺满视口，而对话面板浮在右边缘上压住一块 —— 见 `DiagramRegion`。
 * 视口相关的算法（居中 / 适配 / 缩放锚点）一律按**可视区**算，不按画布算。
 */
import { ICE, ICERect } from 'ice-render';
import { WaterProcessDesigner, WATER_SYMBOL_PRESETS } from 'ice-entity-designer';
// 视口补间用库里的 tween：它走 `resolveICEAnimationDuration()`，
// 于是 `prefers-reduced-motion` / `setICEReducedMotion()` 自动生效 —— 自己写 rAF 就拿不到这个。
import { tween, type ICETweenHandle } from 'ice-web-components';
import { Layer } from '../domain/ice/layer';
import { applyThemeToIce } from '../domain/theme';
import { compileDiagramDsl, type DiagramOp } from '../domain/diagram/compile';
import type { WaterProcessDslDocument } from '../../shared/diagram';

export interface DiagramLayerOptions {
  /**
   * 显式指定初始缩放，**覆盖**默认的"适配 focus 框"算法。
   *
   * 一般不用给：默认算法会把 DSL 里 `viewport.focus` 那一段刚好放进画布（留 `padding`），
   * 于是"先看哪儿"由数据决定、缩放到"刚好放得下"为止，随画布宽度自适应。
   */
  initialScale?: number;
  minScale?: number;
  maxScale?: number;
  /** 初始视野四周的留白（像素） */
  padding?: number;
  /**
   * 初始缩放的**上限**：小图不放大到失真。
   *
   * 下限有 `minScale`、上限有它。没有它的话一张两个单元的小图会被放到 3 倍。
   */
  maxInitialScale?: number;
}

/**
 * 画布上**真正给用户看**的那块区域（CSS 像素，相对画布左上角）。
 *
 * ## 为什么画布要跟"可视区"分开
 *
 * 布局反转之前，图卡是消息流里的一张卡：画布多大，可视区就多大，两者是同一个数。
 * 现在绘图区**铺满视口**、对话面板**浮在它右边缘上**（`position:fixed`），
 * 于是画布宽 1440、而没被面板压住的只有前 1048 —— 两者不再相等。
 *
 * 分开之后语义很干净：
 * - 画布尺寸决定"渲染多少像素"（铺满，完全不透明）；
 * - 可视区决定"内容摆在哪、能动多大"（居中 / 适配 / 缩放锚点全按它算）。
 *
 * 不分的代价是实打实的：按整幅 1440 居中的话，图的正中间落在面板底下，
 * 右边三分之一被白白浪费 —— 而那正是最该看清的主流程后半段。
 */
export interface DiagramRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 高亮：加粗描边 + 一层半透明底。
 *
 * 只加粗描边在小图上几乎看不出来（符号本身描边才 1.4，缩到 0.6 倍之后不到 1px）；
 * 所以再叠一个半透明填充块，形状一眼可辨。
 */
const HIGHLIGHT_LINE_WIDTH = 3;
/** 高亮底块的四周外扩（世界坐标），让框比符号略大一圈 */
const HIGHLIGHT_PADDING = 8;

/**
 * 高亮颜色：**鲜艳的黄**。
 *
 * 为什么不取引擎主题的主色（家族品牌冰蓝 `#61D9FB`）——**因为图纸本身就是蓝的**。
 * 工艺图的水线是浅蓝、出水线是青绿、空气线是浅蓝虚线，主色往上一叠就糊进图里了，
 * 而且"高亮"和"某种介质"看起来一样，读图的人分不出哪个是强调。
 *
 * 黄是这张图上**唯一没被介质占用的醒目色**（9 种介质里没有黄系），
 * 所以它天然是"这是被指的东西，不是管线"。
 *
 * 硬编码而不是进主题表：它是**语义色**（"强调"），不是品牌色 —— 两套主题下都该是同一个黄。
 * 混色时用极低的不透明度做"洗底"，够看出范围又不遮住位号。
 */
const HIGHLIGHT_COLOR = '#FFD400';
/** 底块的洗底色不透明度。0.18 在多介质叠加处仍能看清轮廓。 */
const HIGHLIGHT_WASH_ALPHA = 0.18;

/**
 * 一次"闪一下"：几轮 yoyo、每轮多久、最低暗到多少。
 *
 * ⚠️ `BLINK_ROUNDS` **必须是偶数**。
 *
 * 配合 `direction: 'alternate'` 时，奇偶轮的方向是反的：偶数轮 1→0.2、奇数轮 0.2→1。
 * 引擎的 `shouldRepeat()` 是在**每一轮跑完时**判断还要不要继续，所以轮数用完的那一刻
 * 停在哪一半，取决于最后一轮是奇是偶：
 * - 5 轮（奇）：最后一轮 1→0.2 → **停在最暗处**，闪烁结束后高亮框一直是半透明的；
 * - 6 轮（偶）：最后一轮 0.2→1 → 停在最亮处，高亮框恢复正常。
 *
 * 实测踩过：5 轮时 `blinkInfo().opacity` 终值是 0.2，底块看着像没画出来。
 */
const BLINK_ROUNDS = 6;
const BLINK_MS = 160;
const BLINK_MIN_OPACITY = 0.2;
/** 视口补间时长。够看出"在动"，又不至于让人等。 */
const ZOOM_ANIMATION_MS = 220;
/** 一"步"缩放的默认倍率。 */
const DEFAULT_ZOOM_STEP = 1.35;
/** 一次命令最多走几步（挡住 `steps: 100` 这种把图缩成一点的请求）。 */
const MAX_ZOOM_STEPS = 6;
/** 缩放倍率的夹取范围（与滚轮缩放同一对边界）。 */
const ZOOM_FACTOR_MIN = 0.2;
const ZOOM_FACTOR_MAX = 4;

/**
 * 一次闪烁的动画配置。**每次都要新建一个对象**，不能抽成共享常量。
 *
 * 两个理由，都是引擎的实现细节决定的：
 * 1. `AnimationManager.shouldRepeat()` 会 **`animation.iterationCount--`** ——
 *    复用同一份配置的话，第一次闪烁把它减到 1，第二次就不重复了（表现为"第二次不闪"）；
 * 2. `startTime` / `__iteration` / `finished` 都存在配置对象上，共享会让两个 overlay 互相干扰。
 */
function blinkAnimation(): any {
  return {
    from: 1,
    to: BLINK_MIN_OPACITY,
    duration: BLINK_MS,
    // alternate = 奇偶轮反向，也就是 yoyo；配合 iterationCount 就是"闪几下"
    direction: 'alternate',
    iterationCount: BLINK_ROUNDS,
    easing: 'easeInOut',
  };
}

export class DiagramLayer {
  readonly canvas: HTMLCanvasElement;
  readonly layer: Layer;
  /** 暴露给测试 / 调试（e2e 要读画布内部事实 —— canvas 里没有 DOM 目标可断言）。 */
  readonly ice: any;
  readonly designer: any;

  private readonly doc: WaterProcessDslDocument;
  private readonly options: {
    initialScale?: number;
    minScale: number;
    maxScale: number;
    padding: number;
    maxInitialScale: number;
  };
  /** 编译出来的指令条数（`counts()` 用，避免每次去问设计器）。 */
  private readonly compiled: { symbols: number; pipes: number };

  /** 初始视口只设一次：窗口 resize 重排尺寸时**不能**把用户的缩放平移冲掉。 */
  private viewportReady = false;
  private cssWidth = 0;
  private cssHeight = 0;
  /**
   * 可视区（画布上没被浮动面板压住的那块）。`null` = 整块画布。
   *
   * 只在 `StageView` 明确设置了不同区域时才有值 —— 单独用这一层（比如单测里）
   * 不用关心它。见 `DiagramRegion` 的注释。
   */
  private region: DiagramRegion | null = null;

  /** 当前高亮的单元 id。 */
  private highlightedId: string | null = null;
  /**
   * 高亮期间给该节点打上的 style 备份 + **节点引用本身**。
   *
   * 存引用而不是存 id：还原时按 id 再查一次会依赖"节点还在、id 没改"，
   * 而这个类有 `destroy()` 路径 —— 查询失败就静默留下一个被改过样式的节点。
   */
  private highlightBackup: any = null;
  private highlightNode: any = null;
  /**
   * 盖在高亮符号上的半透明底块（`addTool` 的 UI 覆盖层，不参与序列化）。
   *
   * 带上 `__iceDiagramHighlight` 标记 —— 用来把"本层建的底块"从引擎自己的工具节点里认出来。
   */
  private highlightOverlay: any = null;
  /**
   * 高亮色。**不取主题主色**（见文件上方 `HIGHLIGHT_COLOR` 的注释）——
   * 图纸本身就是蓝的，主色叠上去跟"某种介质管线"长得一样。
   */
  private readonly highlightColor = HIGHLIGHT_COLOR;

  /** 正在跑的视口补间。新命令与 `destroy()` 都要取消它。 */
  private zoomTween: ICETweenHandle | null = null;
  /** 上一次缩放命令（`zoomInfo()` 给 e2e 用）。 */
  private lastZoom: { direction: string; from: number; to: number } | null = null;

  // 拖拽平移的临时状态
  private panning = false;
  private lastX = 0;
  private lastY = 0;
  private readonly disposers: Array<() => void> = [];

  constructor(doc: WaterProcessDslDocument, options: DiagramLayerOptions = {}) {
    this.doc = doc;
    this.options = {
      // undefined = 用"适配 focus 框"算（见 __initialScaleFor）
      initialScale: options.initialScale,
      minScale: options.minScale ?? 0.25,
      maxScale: options.maxScale ?? 2.5,
      padding: options.padding ?? 16,
      maxInitialScale: options.maxInitialScale ?? 1,
    };

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'diagram-canvas';

    // ① 必须 init（见文件抬头）。② 刻意不传 dpr。
    this.ice = new ICE().init(this.canvas, { renderMode: 'dirty-rect' });
    // ③ 主题必须先于设计器
    applyThemeToIce(this.ice);

    this.designer = new WaterProcessDesigner(this.ice);

    // 与另两层一样：画布 + ICE 实例交给 `Layer` 统一管"按显示尺寸对齐 / 一起销毁"
    this.layer = new Layer('diagram', this.canvas, this.ice);

    const ops = compileDiagramDsl(doc);
    this.compiled = {
      symbols: ops.filter((op) => op.op === 'symbol').length,
      pipes: ops.filter((op) => op.op === 'pipe').length,
    };
    this.__build(ops);

    // 建完把选中态清掉：`createSymbol` 每建一个都会把它记成选中项
    this.designer.select(null);

    this.__installPointer();
  }

  /**
   * 按卡片可用尺寸对齐画布，并在**第一次**时设置初始视口。
   *
   * 顺序不能反：初始视口是按画布尺寸算居中的，画布尺寸为 0 时算出来是错的。
   */
  fit(cssWidth: number, cssHeight: number): void {
    this.cssWidth = cssWidth > 0 ? cssWidth : this.cssWidth;
    this.cssHeight = cssHeight > 0 ? cssHeight : this.cssHeight;
    this.layer.fit(this.cssWidth, this.cssHeight);
    if (!this.viewportReady && this.cssWidth > 0 && this.cssHeight > 0) {
      this.viewportReady = true;
      this.__applyInitialViewport();
    }
  }

  /** 符号 / 管线条数（e2e 用它钉「图真的建出来了、数量对」）。 */
  counts(): { symbols: number; pipes: number } {
    return { symbols: this.compiled.symbols, pipes: this.compiled.pipes };
  }

  /**
   * 设定可视区（画布不变）。传 `null` 恢复"整块画布"。
   *
   * @returns 区域是否**真的变了**。调用方据此决定要不要重摆视野 ——
   *          没变还重摆的话，用户拖到的位置会被每次 resize 冲掉。
   */
  setRegion(region: DiagramRegion | null): boolean {
    const next = region
      ? {
          left: Math.max(0, region.left),
          top: Math.max(0, region.top),
          width: Math.max(1, region.width),
          height: Math.max(1, region.height),
        }
      : null;
    const prev = this.region;
    const same =
      (!prev && !next) ||
      (!!prev &&
        !!next &&
        prev.left === next.left &&
        prev.top === next.top &&
        prev.width === next.width &&
        prev.height === next.height);
    if (same) return false;
    this.region = next;
    return true;
  }

  /**
   * 按当前尺寸与可视区**重新摆一次初始视野**（同步，不补间）。
   *
   * 与 `zoomBy({direction:'reset'})` 的区别是"要不要动画"：那个是用户主动按的复位，
   * 给一段 220ms 的过渡更自然；这个是**布局变了**（面板折叠、窗口 resize），
   * 跟着变才不显得脱节 —— 而且 e2e 能立刻断言，不用等动画。
   */
  reframe(): void {
    this.__cancelZoom();
    if (!this.viewportReady || this.cssWidth <= 0 || this.cssHeight <= 0) return;
    this.__applyInitialViewport();
  }

  /**
   * **整图适配**：把全部图元（不是 `viewport.focus` 那一段）框进可视区。
   *
   * 与默认初始视野的分工：
   * - 默认按 `focus` 适配 —— 那是"开页先看主流程"的取景，字大、但看不到全貌；
   * - 这个按**全部图元**适配 —— 是"看整张图纸"的取景，必然字小，用来建立全局印象。
   *
   * 两个都需要：铺开坐标之后整图约 1900×1800，按 focus 取景看不到污泥线与事故支路；
   * 而只看整图又读不出位号。所以一个当"远看"、一个当"近看"。
   */
  fitAll(padding = 24): boolean {
    if (this.cssWidth <= 0 || this.cssHeight <= 0) return false;
    const box = this.__contentBoxOfAll();
    if (!box) return false;
    const r = this.__region();
    const availableW = Math.max(1, r.width - padding * 2);
    const availableH = Math.max(1, r.height - padding * 2);
    const contentW = Math.max(1, box.maxX - box.minX);
    const contentH = Math.max(1, box.maxY - box.minY);
    const fit = Math.min(availableW / contentW, availableH / contentH);
    const scale = Math.max(this.options.minScale, Math.min(this.options.maxScale, fit));
    this.__cancelZoom();
    this.ice.setViewport(scale, this.__centerTx(box, scale), this.__centerTy(box, scale));
    return true;
  }

  /**
   * 工艺校验（引擎的 `validateWater()`：位号唯一、单元要有进出线、管线要标介质与管径、
   * 出水路径必须有在线监测、剩余污泥要有出路、AAO 要有内回流…）。
   *
   * 这条是**跨仓一致性**的锚点：同一份案例数据在 ice-smart-water 里也是零问题，
   * 搬过来之后必须还是零问题，否则说明搬的过程中改了语义。
   */
  issues(): Array<{ level: string; code: string; message: string; id?: string }> {
    return this.designer.validateWater().map((issue: any) => ({
      level: issue.level,
      code: issue.code,
      message: issue.message,
      id: issue.id,
    }));
  }

  /** 当前高亮的单元 id（e2e 用）。 */
  get pointedId(): string | null {
    return this.highlightedId;
  }

  /**
   * 当前视口与"被框住的那块"的实测值（调试 / e2e 用）。
   *
   * 为什么要暴露：canvas 里没有 DOM 目标，"图有没有被裁到框外"只能靠
   * 把「内容包围盒经视口变换后的屏幕范围」跟画布尺寸比 —— 而这两样都在组件内部。
   */
  viewportInfo(): {
    scale: number;
    tx: number;
    ty: number;
    cssWidth: number;
    cssHeight: number;
    /** 可视区（画布上没被浮动面板压住的那块）。等于画布时也是显式的，方便断言。 */
    region: DiagramRegion;
    /** 内容（全部图元）的屏幕范围，已应用视口变换 */
    screenBox: { left: number; top: number; right: number; bottom: number } | null;
    /** 全部图元的世界坐标包围盒 */
    contentBox: { minX: number; minY: number; maxX: number; maxY: number } | null;
    /** 初始视野被框住的那块（世界坐标） */
    focusBox: { minX: number; minY: number; maxX: number; maxY: number } | null;
  } {
    const viewport = this.ice.viewport || { scale: 1, tx: 0, ty: 0 };
    const box = this.__contentBoxOfAll();
    const focus = this.__focusBox();
    const scale = Number(viewport.scale) || 1;
    const tx = Number(viewport.tx) || 0;
    const ty = Number(viewport.ty) || 0;
    return {
      scale,
      tx,
      ty,
      cssWidth: this.cssWidth,
      cssHeight: this.cssHeight,
      region: this.__region(),
      screenBox: box
        ? {
            left: box.minX * scale + tx,
            top: box.minY * scale + ty,
            right: box.maxX * scale + tx,
            bottom: box.maxY * scale + ty,
          }
        : null,
      contentBox: box,
      focusBox: focus,
    };
  }

  /**
   * 「指着讲」：把某个单元**移进视野并高亮**。
   *
   * 为什么要顺带平移：图比卡片宽得多，讲到的单元很可能不在当前视野里 ——
   * 那样高亮是发生在一个看不见的地方，等于没讲。演示时"镜头跟过去"是自然动作。
   *
   * 高亮本身没有引擎原语可用（`chrome.selection` 只由 mousedown 触发的控制面板消费，
   * `designer.select()` 只改一个字段、没有渲染消费者），所以走 `WaterSymbol` 的
   * style 补丁：它会触发 `syncShape()` 重建内部图形。
   * ⚠️ `WaterSymbol.applyPatch` **不置 dirty**（与 `FlowNode` 不同），必须自己置。
   *
   * @param value 单元业务 id 或位号（`tag`），两者都认 —— agent 措辞里更常出现位号
   * @returns 是否找到了这个单元
   */
  pointAt(value: any, opts: { blink?: boolean } = {}): boolean {
    const target = this.__findNode(value);
    if (!target) return false;

    this.__clearHighlight();
    this.highlightBackup = { ...(target.state.style || {}) };
    this.highlightNode = target;
    this.highlightedId = String(target.state.id);
    target.applyPatch({
      style: {
        ...this.highlightBackup,
        strokeStyle: this.highlightColor,
        lineWidth: HIGHLIGHT_LINE_WIDTH,
      },
    });
    // `WaterSymbol.applyPatch` 不置 dirty（与 FlowNode 不同），必须自己置
    this.ice.dirty = true;

    this.__showOverlay(target, opts.blink === true);
    this.__centerOn(target);
    return true;
  }

  clearPoint(): void {
    if (!this.highlightedId) return;
    this.__clearHighlight();
    this.ice.dirty = true;
  }

  /**
   * 缩放视图（agent 的命令）。
   *
   * 四个方向：
   * - `in` / `out` —— **相对**当前倍率叠（`factor^steps`，夹在 min/max 之间）；
   * - `reset` —— 回到**初始视野**（按 DSL 的 `viewport.focus` 适配的那一屏）；
   * - `to` —— **绝对**倍率，给一个目标 `scale`。
   *
   * 为什么 `reset` 不是 `scale = 1`：这张图是世界坐标里一张 1900 宽的图，
   * 1 倍根本装不进可视区（那是"回到一个看不清全貌的状态"）。用户说"复位"要的是
   * "回到刚画出来时的样子"，也就是按 DSL 的 `viewport.focus` 适配的那一屏。
   *
   * 为什么还要 `to`：**讲解脚本需要"讲到哪里放大到哪一档"**。相对缩放会累积 ——
   * 一段十拍的解说里叠三次 `in`，倍率就飘到 2.5 倍且不可预期；而 `to: 1.4` 是幂等的，
   * 无论前面发生过什么，这一拍之后就是 1.4。所以讲稿用 `to`，人/模型的手势用 `in`/`out`。
   *
   * @returns 是否作用在了一张图上（图表图层走到这里会返回 false，不报错）
   */
  zoomBy(cmd: {
    direction: 'in' | 'out' | 'reset' | 'to';
    factor?: number;
    steps?: number;
    scale?: number;
  }): boolean {
    if (!this.cssWidth || !this.cssHeight) return false;

    const current = this.__viewport();
    let next: { scale: number; tx: number; ty: number };

    if (cmd.direction === 'reset') {
      const box = this.__focusBox();
      if (!box) return false;
      const scale = this.__initialScaleFor(box);
      next = { scale, tx: this.__centerTx(box, scale), ty: this.__centerTy(box, scale) };
    } else if (cmd.direction === 'to') {
      const raw = Number(cmd.scale);
      if (!Number.isFinite(raw) || raw <= 0) return false; // 非法目标倍率：当作没来过
      const scale = Math.max(this.options.minScale, Math.min(this.options.maxScale, raw));
      if (Math.abs(scale - current.scale) < 1e-6) return true;
      next = { scale, tx: this.__centerTxOfCurrent(current, scale), ty: this.__centerTyOfCurrent(current, scale) };
    } else {
      const rawFactor = Number(cmd.factor);
      const factor = Number.isFinite(rawFactor) && rawFactor > 0 ? rawFactor : DEFAULT_ZOOM_STEP;
      const rawSteps = Number(cmd.steps);
      const steps = Number.isFinite(rawSteps) && rawSteps > 0 ? Math.min(Math.floor(rawSteps), MAX_ZOOM_STEPS) : 1;
      const base = cmd.direction === 'in' ? factor : 1 / factor;
      const wanted = current.scale * Math.pow(base, steps);
      const scale = Math.max(this.options.minScale, Math.min(this.options.maxScale, wanted));
      if (Math.abs(scale - current.scale) < 1e-6) return true; // 已经到头了：不算失败，但也没必要动
      // 锚点 = 可视区中心：让"当前在中心的世界点"缩放后仍在中心。
      // 与 `ICE.zoomAt()` 同口径（它反解平移保锚点），只是锚点固定在中心而不是光标处。
      next = { scale, tx: this.__centerTxOfCurrent(current, scale), ty: this.__centerTyOfCurrent(current, scale) };
    }

    this.__animateViewport(current, next, cmd.direction);
    return true;
  }

  /** 当前视口与上一次缩放命令（调试 / e2e 用）。 */
  zoomInfo(): {
    scale: number;
    tx: number;
    ty: number;
    animating: boolean;
    last: { direction: string; from: number; to: number } | null;
  } {
    const viewport = this.__viewport();
    return { scale: viewport.scale, tx: viewport.tx, ty: viewport.ty, animating: this.zoomTween !== null, last: this.lastZoom };
  }

  /**
   * 最近一次闪烁的状态（调试 / e2e 用）。没在闪时 `id` 为 null。
   *
   * 带上 `overlays`（当前工具层里的节点数）：**每次闪烁都换一个新的底块**，
   * 所以这个数不能随闪烁次数增长 —— 它是"有没有泄漏"的直接读数
   * （漏掉 `removeTool` 的话，每闪一次就多留一层半透明块，画面会越来越糊）。
   */
  blinkInfo(): { id: string | null; opacity: number; animating: boolean; overlays: number } {
    const overlay = this.highlightOverlay;
    const tools: any[] = Array.isArray(this.ice.toolNodes) ? this.ice.toolNodes : [];
    // 只数**本层打的标记**，不数引擎自己的工具（见 `__showOverlay` 的注释）
    const overlays = tools.filter((n) => n && n.__iceDiagramHighlight).length;
    if (!overlay) return { id: null, opacity: 1, animating: false, overlays };
    const opacity = overlay.state && typeof overlay.state.opacity === 'number' ? overlay.state.opacity : 1;
    return {
      id: this.highlightedId,
      opacity,
      animating: !!(this.ice.animationManager && this.ice.animationManager.isAnimating(overlay)),
      overlays,
    };
  }

  // -------------------------------------------------------------------------
  // 视口内部
  // -------------------------------------------------------------------------

  private __viewport(): { scale: number; tx: number; ty: number } {
    const v = this.ice.viewport || {};
    const scale = Number(v.scale);
    return {
      scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
      tx: Number(v.tx) || 0,
      ty: Number(v.ty) || 0,
    };
  }

  /** 可视区。没显式设过就是整块画布。 */
  private __region(): DiagramRegion {
    return this.region ?? { left: 0, top: 0, width: this.cssWidth, height: this.cssHeight };
  }

  /** 可视区的中心（视口相关算法的锚点都用它，而不是画布中心）。 */
  private __regionCx(): number {
    const r = this.__region();
    return r.left + r.width / 2;
  }
  private __regionCy(): number {
    const r = this.__region();
    return r.top + r.height / 2;
  }

  /** 视口下"可视区中心"对应的世界坐标（锚点反解用）。`screen = world × scale + t`。 */
  private __worldAtCenterX(v: { scale: number; tx: number }): number {
    return (this.__regionCx() - v.tx) / v.scale;
  }
  private __worldAtCenterY(v: { scale: number; ty: number }): number {
    return (this.__regionCy() - v.ty) / v.scale;
  }

  /** 把某块世界坐标居中到可视区上（给定 scale）。 */
  private __centerTx(box: { minX: number; maxX: number }, scale: number): number {
    return this.__regionCx() - ((box.minX + box.maxX) / 2) * scale;
  }
  private __centerTy(box: { minY: number; maxY: number }, scale: number): number {
    return this.__regionCy() - ((box.minY + box.maxY) / 2) * scale;
  }

  /**
   * 「保持当前视口中心那个世界点不动」地把 scale 换掉 —— `in` / `out` / `to` 都走它。
   *
   * 与 `__worldAtCenter*` 是同一件事的两半：先反解出中心的世界点，再按新 scale 正解回平移。
   * 抽出来是因为三个方向都要这一步，而这里少乘或多乘一次 scale，内容就会"甩出去"。
   */
  private __centerTxOfCurrent(current: { scale: number; tx: number; ty: number }, scale: number): number {
    return this.__regionCx() - this.__worldAtCenterX(current) * scale;
  }
  private __centerTyOfCurrent(current: { scale: number; tx: number; ty: number }, scale: number): number {
    return this.__regionCy() - this.__worldAtCenterY(current) * scale;
  }

  /**
   * 平滑地把视口推过去。
   *
   * 补间的是 **scale + tx + ty 三元组**而不是每帧反解锚点 —— 因为锚点固定时
   * `tx` 对 `scale` 是**线性**的（`tx = cx - wx·scale`，`wx` 是常量），
   * 所以线性插值与"每帧重算锚点"数学上等价，前者更简单也更好断言。
   */
  private __animateViewport(
    from: { scale: number; tx: number; ty: number },
    to: { scale: number; tx: number; ty: number },
    direction: string
  ): void {
    this.__cancelZoom();
    this.lastZoom = { direction, from: from.scale, to: to.scale };

    // 已经到位（或减少动效把时长解析成 0）就不补间
    if (from.scale === to.scale && from.tx === to.tx && from.ty === to.ty) return;

    this.zoomTween = tween({
      from: 0,
      to: 1,
      duration: ZOOM_ANIMATION_MS,
      easing: 'easeOut',
      onUpdate: (t) => {
        this.ice.setViewport(
          from.scale + (to.scale - from.scale) * t,
          from.tx + (to.tx - from.tx) * t,
          from.ty + (to.ty - from.ty) * t
        );
      },
      onFinish: () => {
        this.zoomTween = null;
      },
    });
  }

  private __cancelZoom(): void {
    if (!this.zoomTween) return;
    this.zoomTween.cancel();
    this.zoomTween = null;
  }

  destroy(): void {
    // 先取消补间：否则会留一个 rAF 句柄往已销毁的实例上写视口
    this.__cancelZoom();
    this.__hideOverlay();
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    this.designer.dispose();
    this.layer.destroy();
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /** 照着指令表建图元。`createPipe` 要求两端已存在，所以 symbol 必须先全建完（见 compile.ts）。 */
  private __build(ops: DiagramOp[]): void {
    for (const op of ops) {
      if (op.op === 'symbol') {
        this.designer.createSymbol(op.kind, {
          id: op.id,
          name: op.name,
          tag: op.tag,
          left: op.left,
          top: op.top,
          // 只读：不给交互、不给拖拽。但**不**动 `interactive` 之外的命中 ——
          // 拖拽平移正是靠"空白处才平移"，图元不吃事件才拖得动
          interactive: false,
          draggable: false,
        });
      } else {
        this.designer.createPipe({
          id: op.id,
          sourceId: op.sourceId,
          targetId: op.targetId,
          medium: op.medium,
          dn: op.dn,
          sourcePort: op.sourcePort,
          targetPort: op.targetPort,
        });
      }
    }
  }

  /**
   * 初始视口：把 `viewport.focus` 列出的单元（没写就是全图）**居中**，按 `initialScale` 缩放。
   *
   * 注意这是"居中"而不是"整图适配"：图比卡片宽，适配会小到读不出来（见 `initialScale` 注释）。
   */
  private __applyInitialViewport(): void {
    const box = this.__focusBox();
    if (!box) return;
    const scale = this.__initialScaleFor(box);
    const r = this.__region();
    this.ice.setViewport(
      scale,
      r.left + (r.width - (box.minX + box.maxX) * scale) / 2,
      r.top + (r.height - (box.minY + box.maxY) * scale) / 2
    );
  }

  /**
   * 初始缩放：把**要框住的那块**刚好放进可视区（四周留 `padding`），并夹在允许范围内。
   *
   * 为什么是"框住 focus 框"而不是"框住整图"：
   * 这张图的世界宽约 1460，而可视区只有 ~1050 —— 整图适配得到 ~0.7 但那是**因为**
   * 图上有一大块（事故池支路、污泥线、除臭）并不在主流程线上；
   * 而 DSL 已经用 `viewport.focus` 明确说了"先看主流程"，那就按它算。
   *
   * 为什么还要 `maxInitialScale`：小图（比如两个单元）按"刚好放得下"会放大到几倍，
   * 位号文字糊成一片。图上限 1 倍，够用又不失真。
   *
   * 两个轴都算、取小的那个 —— 只按宽算的话，一张比可视区还高的图会纵向被裁掉。
   */
  private __initialScaleFor(box: { minX: number; minY: number; maxX: number; maxY: number }): number {
    if (this.options.initialScale !== undefined) {
      return this.options.initialScale;
    }
    const pad = this.options.padding;
    const r = this.__region();
    const availableW = Math.max(1, r.width - pad * 2);
    const availableH = Math.max(1, r.height - pad * 2);
    const contentW = Math.max(1, box.maxX - box.minX);
    const contentH = Math.max(1, box.maxY - box.minY);
    const fit = Math.min(availableW / contentW, availableH / contentH);
    const capped = Math.min(fit, this.options.maxInitialScale);
    return Math.max(this.options.minScale, Math.min(this.options.maxScale, capped));
  }

  /** 一组节点的世界坐标包围盒。 */
  private __bboxOf(nodes: any[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      const box = this.__boxOf(node);
      if (!box) continue;
      minX = Math.min(minX, box.minX);
      minY = Math.min(minY, box.minY);
      maxX = Math.max(maxX, box.maxX);
      maxY = Math.max(maxY, box.maxY);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
    return { minX, minY, maxX, maxY };
  }

  /** 全部图元（含管线）的包围盒 —— 判"有没有被裁"要用它，不能用聚焦框。 */
  private __contentBoxOfAll(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    return this.__bboxOf(this.designer.nodes || []);
  }

  /** 要框住的区域：DSL 里 `viewport.focus` 指到的单元，没写就全部单元。 */
  private __focusBox(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const nodes: any[] = this.designer.nodes || [];
    if (!nodes.length) return null;
    const focus = this.doc.viewport?.focus;
    const picked = Array.isArray(focus) && focus.length
      ? nodes.filter((node: any) => focus.indexOf(String(node.state?.id)) >= 0)
      : nodes;
    return this.__bboxOf(picked.length ? picked : nodes);
  }

  /** 节点在**世界坐标**里的包围盒（含位号/名称文字，所以比 state 的盒子大）。 */
  private __boxOf(node: any): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (!node || typeof node.getMinBoundingBox !== 'function') return null;
    const box = node.getMinBoundingBox(true);
    if (!box || !box.tl || !box.br) return null;
    return { minX: box.tl[0], minY: box.tl[1], maxX: box.br[0], maxY: box.br[1] };
  }

  /** 把某个单元移到可视区中央（只在尺寸已知时有效）。 */
  private __centerOn(node: any): void {
    if (!this.cssWidth || !this.cssHeight) return;
    const box = this.__boxOf(node);
    if (!box) return;
    const scale = Number(this.ice.viewport?.scale) || this.options.initialScale;
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    this.ice.setViewport(scale, this.__regionCx() - cx * scale, this.__regionCy() - cy * scale);
  }

  /** 按业务 id 或位号找单元。 */
  private __findNode(value: any): any {
    if (value === undefined || value === null) return null;
    const key = String(value);
    const nodes: any[] = this.designer.nodes || [];
    return (
      nodes.find((node: any) => String(node.state?.id) === key) ||
      nodes.find((node: any) => String(node.state?.tag) === key) ||
      null
    );
  }

  private __clearHighlight(): void {
    if (!this.highlightedId) return;
    if (this.highlightNode && this.highlightBackup) {
      this.highlightNode.applyPatch({ style: { ...this.highlightBackup } });
    }
    this.__hideOverlay();
    this.highlightedId = null;
    this.highlightBackup = null;
    this.highlightNode = null;
  }

  /**
   * 盖一层半透明底块把高亮符号"框"出来。
   *
   * 为什么用 `ice.addTool()` 而不是 `addChild`：工具层是 **UI 覆盖层**——
   * 不会被序列化、不参与命中测试、不参与布局。正好是"瞬时的演示动作"该待的地方
   * （与归约器对「指着讲」的定位一致：不是需要恢复的状态）。
   */
  private __showOverlay(target: any, blink = false): void {
    this.__hideOverlay();
    const box = this.__boxOf(target);
    if (!box) return;
    const pad = HIGHLIGHT_PADDING;
    const overlay = new ICERect({
      left: box.minX - pad,
      top: box.minY - pad,
      width: box.maxX - box.minX + pad * 2,
      height: box.maxY - box.minY + pad * 2,
      radius: 6,
      fill: true,
      stroke: false,
      interactive: false,
      style: {
        fillStyle: this.__highlightWash(),
      },
    });
    // 压在符号**下面**：盖在上面会把位号与名称糊掉，而那两个正是要读的东西。
    // 同一个 ICE 里靠 zIndex 排序，给一个很小的负值最省事也最稳。
    overlay.setState({ zIndex: -1 });
    // 打个标记：`ice.toolNodes` 是**引擎共用的工具层**，里面本来就有对齐引导线、
    // 控制面板、连线插槽等一大堆引擎自己的东西（实测基线 7~9 个）。
    // 想数"我自己的底块有没有泄漏"就只能认自己打的标记，数 toolNodes 总数是在数引擎。
    (overlay as any).__iceDiagramHighlight = true;
    this.ice.addTool(overlay);
    this.highlightOverlay = overlay;

    if (blink) {
      // ⚠️ 顺序是承重的：`setAnimation()` 内部是
      // `if (this.ice && this.ice.animationManager) add(this)`，而 `this.ice`
      // 是 `addTool()` 赋的 —— addTool 又**不**自己注册动画（只有 `addChild` 才会探测
      // `props.animations`）。所以在 addTool 之前调 setAnimation 会静默不跑：
      // 动画配置进去了、管理器里却没有这个组件，既不报错也不闪。
      overlay.setAnimation('opacity', blinkAnimation());
    }

    this.ice.dirty = true;
  }

  private __hideOverlay(): void {
    if (!this.highlightOverlay) return;
    this.ice.removeTool(this.highlightOverlay);
    this.highlightOverlay = null;
    this.ice.dirty = true;
  }

  /** 高亮底块的颜色：黄压到很低的不透明度，够看出范围又不遮位号。 */
  private __highlightWash(): string {
    return hexToRgba(this.highlightColor, HIGHLIGHT_WASH_ALPHA) || 'rgba(255,212,0,0.18)';
  }

  /**
   * 滚轮缩放 + 空白处拖拽平移。
   *
   * 复用引擎原语，不自己造：`ice.zoomAt(x, y, factor, min, max)` 以光标为锚点缩放，
   * `ice.setViewport(scale, tx, ty)` 平移，`ice.hitTest(x, y)` 判断按到了图元还是空白。
   *
   * 为什么"空白处才平移"：图元虽然建成不可交互，但保留这个判断能让以后放开只读时
   * 不用改这段；而且中键在任何位置都能平移，手感与常见图纸工具一致。
   */
  private __installPointer(): void {
    const canvas = this.canvas;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      this.ice.zoomAt(
        event.offsetX,
        event.offsetY,
        event.deltaY > 0 ? 1 / 1.1 : 1.1,
        this.options.minScale,
        this.options.maxScale
      );
    };

    const onMouseDown = (event: MouseEvent) => {
      const onBlank = event.button === 0 && !this.ice.hitTest(event.offsetX, event.offsetY);
      if (event.button !== 1 && !onBlank) return;
      event.preventDefault();
      // 不让引擎把它当成一次"点空白取消选中"
      event.stopPropagation();
      this.panning = true;
      this.lastX = event.offsetX;
      this.lastY = event.offsetY;
      canvas.style.cursor = 'grabbing';
    };

    const onMouseMove = (event: MouseEvent) => {
      if (!this.panning) return;
      const viewport = this.ice.viewport || { scale: 1, tx: 0, ty: 0 };
      this.ice.setViewport(
        viewport.scale,
        viewport.tx + (event.offsetX - this.lastX),
        viewport.ty + (event.offsetY - this.lastY)
      );
      this.lastX = event.offsetX;
      this.lastY = event.offsetY;
    };

    const stopPan = () => {
      if (!this.panning) return;
      this.panning = false;
      canvas.style.cursor = 'grab';
    };

    const onAuxClick = (event: MouseEvent) => {
      if (event.button === 1) event.preventDefault();
    };

    canvas.style.cursor = 'grab';
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', stopPan);
    canvas.addEventListener('mouseleave', stopPan);
    canvas.addEventListener('auxclick', onAuxClick);

    this.disposers.push(() => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseup', stopPan);
      canvas.removeEventListener('mouseleave', stopPan);
      canvas.removeEventListener('auxclick', onAuxClick);
    });
  }
}

/**
 * `#rgb` / `#rrggbb` → `rgba(...)`。
 *
 * 主题给的主色是十六进制，而高亮底块要的是半透明 —— 引擎的 `fillStyle` 不认
 * "十六进制 + 单独的不透明度"这种写法，只能自己转。
 */
function hexToRgba(color: string, alpha: number): string | null {
  if (typeof color !== 'string') return null;
  let hex = color.trim();
  if (hex.charAt(0) !== '#') return null;
  hex = hex.slice(1);
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  if (hex.length !== 6) return null;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return null;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 某个符号种类的预设尺寸（卡片需要它来估画布该多高时可查）。 */
export function presetSizeOf(kind: string): { width: number; height: number } {
  const preset: any = (WATER_SYMBOL_PRESETS as any)[kind];
  return { width: preset?.width ?? 0, height: preset?.height ?? 0 };
}
