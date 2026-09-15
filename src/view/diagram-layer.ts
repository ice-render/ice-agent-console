/**
 * 卡片里的**图卡片层**：把一份图 DSL 画到自己的 canvas 上（`ice-entity-designer`）。
 *
 * 与另外两层的关系：图表层用 `ice-chart`、表单层用 `ice-web-components-dsl`，
 * 这一层用 `ice-entity-designer` 的 `WaterProcessDesigner`。三者都是
 * **一块 canvas + 一个 ICE 实例**（引擎的模型：「一层 = 一个实例 + 一张画布」）。
 *
 * ## 只读，但可缩放平移
 *
 * 语义是"**看**图，不是**编辑**图"：符号建成 `interactive:false / draggable:false`，
 * 也不能增删。但滚轮缩放与空白处拖拽平移是**查看**手段，必须有 ——
 * 这张图的世界尺寸约 1454×985，而卡片可用宽度只有 ~872px：
 * 整图适配会把 12px 的位号文字压到 6~7px，根本读不出来。
 * 所以策略是「**看一段、拖着看**」而不是"看缩略图"。
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
 */
import { ICE, ICERect } from 'ice-render';
import { WaterProcessDesigner, WATER_SYMBOL_PRESETS } from 'ice-entity-designer';
import { Layer } from '../domain/ice/layer';
import { applyThemeToIce } from '../domain/theme';
import { compileDiagramDsl, type DiagramOp } from '../domain/diagram/compile';
import type { WaterProcessDslDocument } from '../../shared/diagram';

export interface DiagramLayerOptions {
  /**
   * 显式指定初始缩放，**覆盖**默认的"适配 focus 框"算法。
   *
   * 一般不用给：默认算法会把 DSL 里 `viewport.focus` 那一段刚好放进卡片（留 `padding`），
   * 于是"先看哪儿"由数据决定、缩放到"刚好放得下"为止，随卡片宽度自适应。
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
 * 高亮：加粗描边 + 一层半透明底。
 *
 * 只加粗描边在小图上几乎看不出来（符号本身描边才 1.4，缩到 0.6 倍之后不到 1px）；
 * 所以再叠一个半透明填充块，形状一眼可辨。
 */
const HIGHLIGHT_LINE_WIDTH = 3;
/** 高亮底块的四周外扩（世界坐标），让框比符号略大一圈 */
const HIGHLIGHT_PADDING = 8;

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
  /** 盖在高亮符号上的半透明底块（`addTool` 的 UI 覆盖层，不参与序列化）。 */
  private highlightOverlay: any = null;
  private highlightColor = '#61D9FB';

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
    this.highlightColor = this.__readHighlightColor();

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
  pointAt(value: any): boolean {
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

    this.__showOverlay(target);
    this.__centerOn(target);
    return true;
  }

  clearPoint(): void {
    if (!this.highlightedId) return;
    this.__clearHighlight();
    this.ice.dirty = true;
  }

  destroy(): void {
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

  /** 高亮色取引擎主题的主色（与设计器外壳同源）。 */
  private __readHighlightColor(): string {
    const theme: any = typeof this.ice.getTheme === 'function' ? this.ice.getTheme() : null;
    const semantic: any = (theme && theme.semantic) || {};
    return semantic.primary || semantic.info || '#61D9FB';
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
    this.ice.setViewport(
      scale,
      (this.cssWidth - (box.minX + box.maxX) * scale) / 2,
      (this.cssHeight - (box.minY + box.maxY) * scale) / 2
    );
  }

  /**
   * 初始缩放：把**要框住的那块**刚好放进卡片（四周留 `padding`），并夹在允许范围内。
   *
   * 为什么是"框住 focus 框"而不是"框住整图"：
   * 这张图的世界宽约 1460，而卡片只有 ~872 —— 整图适配得到 ~0.55 但那是**因为**
   * 图上有一大块（事故池支路、污泥线、除臭）并不在主流程线上；
   * 而 DSL 已经用 `viewport.focus` 明确说了"先看主流程"，那就按它算。
   *
   * 为什么还要 `maxInitialScale`：小图（比如两个单元）按"刚好放得下"会放大到几倍，
   * 位号文字糊成一片。图上限 1 倍，够用又不失真。
   *
   * 两个轴都算、取小的那个 —— 只按宽算的话，一张比卡片还高的图会纵向被裁掉。
   */
  private __initialScaleFor(box: { minX: number; minY: number; maxX: number; maxY: number }): number {
    if (this.options.initialScale !== undefined) {
      return this.options.initialScale;
    }
    const pad = this.options.padding;
    const availableW = Math.max(1, this.cssWidth - pad * 2);
    const availableH = Math.max(1, this.cssHeight - pad * 2);
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

  /** 把某个单元移到视野中央（只在尺寸已知时有效）。 */
  private __centerOn(node: any): void {
    if (!this.cssWidth || !this.cssHeight) return;
    const box = this.__boxOf(node);
    if (!box) return;
    const scale = Number(this.ice.viewport?.scale) || this.options.initialScale;
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    this.ice.setViewport(scale, this.cssWidth / 2 - cx * scale, this.cssHeight / 2 - cy * scale);
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
  private __showOverlay(target: any): void {
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
    this.ice.addTool(overlay);
    this.highlightOverlay = overlay;
    this.ice.dirty = true;
  }

  private __hideOverlay(): void {
    if (!this.highlightOverlay) return;
    this.ice.removeTool(this.highlightOverlay);
    this.highlightOverlay = null;
    this.ice.dirty = true;
  }

  /** 高亮底块的颜色：主色压到很低的不透明度，够看出范围又不遮内容。 */
  private __highlightWash(): string {
    return hexToRgba(this.highlightColor, 0.18) || 'rgba(97,217,251,0.18)';
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
