/**
 * **管线标注的自动避让** —— 纯逻辑，可以直接单测。
 *
 * ## 它解决的是哪一类"叠"
 *
 * `layout.ts` 管的是**单元之间**（落墨盒 = 形状 ∪ 位号 ∪ 名称，有棘轮，线上实测 0 处）。
 * 但线下实测还有一类它管不到的：**管线标注压在单元上**（本仓 2026-09-26 在线上量到
 * 50 处，占小盒 25%~55%），还有 5 处标注互相压。
 *
 * 为什么以前管不了：标注锚点由引擎定死在折线的**中段折点**上（`ICEPolyLine.getLabelPosition()`：
 * 2 点取中点、多点取 `points[floor(len/2)]`），而折点是路由器为了避开**符号盒**折出来的 ——
 * 于是标注与符号的相对位置**尺度不变**：把图元间距放大 1.45→2.2 倍，数量稳定在 43~45，
 * 一动都不动。应用层**唯一**的出路是给标注一个偏移（引擎 2026-09-18 补的
 * `style.label.offset`，见 `docs/upstream-gaps.md` 第 16 条）—— 这个文件就是"偏移该给多少"。
 *
 * ## 算法（故意简单、可预期、可单测）
 *
 * 逐条标注、按输入顺序处理（顺序固定 → 结果确定）：
 *
 * 1. 原位不撞任何单元、也不撞**已经放好的标注** → 不动它（`[0, 0]`）；
 * 2. 否则**往远离'撞得最狠的那个单元'的方向**推：先试邻近的几个候选位移（步长 `step`，
 *    最近优先），取第一个"完全清空"的；
 * 3. 都不清空时取**撞得最少**的那个，并受 `maxSteps` 上限约束（挪太远反而看不出它标的是哪根管）。
 *
 * 为什么按"远离最狠的那个"定方向而不是四方向轮着试：标注落在折线上，最自然的挪法是
 * **沿法向离开那个压住它的单元**；四方向轮试会把标注横着拽到自己那根管子的另一侧，
 * 看起来像标错了管子。
 *
 * ⚠️ **别在这里引入"整图重排"**：这套东西只挪**文字**，不碰折线、不碰图元坐标 ——
 * 挪线要重路由、挪图元会与 `layout.ts` 的棘轮打架。文字是唯一"挪了没副作用"的东西。
 *
 * ⚠️ 阈值与 `layout.ts` 同口径（占小盒 ≥2% 才算压住），别各写一套。
 */

/** 轴对齐盒（世界坐标）。单元落墨盒与标注盒共用这个形状。 */
export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 一条管线标注在**零偏移**时的盒子（锚点在折线上，盒子由引擎的度量给出）。 */
export interface LabelBox extends Box {
  id: string;
  text?: string;
  /**
   * 标注**锚在折线上的那个点**（与盒子同一坐标系）。
   *
   * 给了它就多一条硬约束：任何候选位都不许把盒子挪到离锚点 `ANCHOR_KEEP_OUT` 以内 ——
   * 也就是**不许为了避让又压回自己那根线上**。踩过：求解器把一条竖排标注推到
   * `base + [-16, 0]`（距锚点 2px），它确实不压别人了，却重新压住了自己的线。
   */
  anchor?: Point;
  /**
   * 这条标注的**默认错开量**（世界单位，相对折线上的锚点）。
   *
   * 图纸惯例是"标注贴在管子旁边"而不是压在管子上，所以调用方先算一个法向净距
   * （见 `normalClearanceOf()`），本模块在它**之上**再解冲突 —— 于是
   * "本来就压不住"的那些标注也会离开线，而不是只有撞了的才挪。
   * 不传就是老行为（从锚点原位开始试）。
   */
  base?: [number, number];
  /**
   * **候选排版**（按偏好排序）：每种给"角度 + 基准位 + 该基准位下的盒子"。
   *
   * 为什么要这个：竖排让标注变"横窄竖高"，遇上窄走廊（两边都有东西）时竖排反而放不下 ——
   * 那时应当**退回横排**，而不是硬把竖排推到很远。给了它，求解器就把"朝向"和"位置"一起解：
   * 先按第一个候选试遍所有位移，不行再换下一个候选。
   * 不给则退回老行为（单一位移候选：`base` + 位移，角度 0）。
   */
  placements?: Array<{ angle: number; base: [number, number]; box: Box }>;
}

/** 显式给了偏移的标注：自动避让**不许动它**，但别人要躲开它。 */
export interface PinnedLabel {
  id: string;
  box: Box;
}

export interface LabelPlanInput {
  /** 已经摆好的单元落墨盒（含位号 / 名称）。 */
  units: Box[];
  /** 待避让的标注（零偏移盒子），按输入顺序处理。 */
  labels: LabelBox[];
  /** 人工 / 模型显式给了偏移的那几条：原样放置，不参与求解。 */
  pinned?: PinnedLabel[];
  /** 候选位移的步长（世界像素）。默认 16：约等于标注字高的一半。 */
  step?: number;
  /** 每个方向最多试几跳。默认 4（最远 64 世界像素）。 */
  maxSteps?: number;
  /** 判"压住"的比例阈值。默认 0.02，与 `layout.ts` 同口径。 */
  minRatio?: number;
}

export interface PlannedOffset {
  id: string;
  /** 相对**零偏移锚点**的绝对位移（不是增量）—— 反复调用结果一致。 */
  offset: [number, number];
  /** 该位移对应的旋转角（弧度）。0 = 横排。 */
  angle: number;
}

const area = (b: Box): number => Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY);

const intersection = (a: Box, b: Box): number => {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  return w > 0 && h > 0 ? w * h : 0;
};

/** 交叠面积占**小盒**的比例。盒子退化（宽或高为 0）时返回 0。 */
export function overlapRatio(a: Box, b: Box): number {
  const min = Math.min(area(a), area(b));
  return min > 0 ? intersection(a, b) / min : 0;
}

/** 点到盒子的最短距离（点在盒内时为 0）。 */
export function pointBoxDistance(p: Point, b: Box): number {
  const dx = Math.max(b.minX - p.x, 0, p.x - b.maxX);
  const dy = Math.max(b.minY - p.y, 0, p.y - b.maxY);
  return Math.hypot(dx, dy);
}

export const shifted = (b: Box, offset: [number, number]): Box => ({
  minX: b.minX + offset[0],
  minY: b.minY + offset[1],
  maxX: b.maxX + offset[0],
  maxY: b.maxY + offset[1],
});

const centerOf = (b: Box): [number, number] => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];

/**
 * 标注中心离锚点的**最小距离**（世界像素）—— 判据用的下限。
 *
 * 真正写进去的基准位由 `planLabelPlacement()` 算：`盒的半高 + 4`（盒子边缘离线条 4px）。
 * 这个常数只作为"离线了没有"的断言下限（e2e 用），比实际基准位略小。
 */
export const LABEL_CLEARANCE = 12;

/** 盒子的边缘离线条留多少（世界像素）。 */
export const LABEL_EDGE_GAP = 4;

/** 标注盒离**自己的锚点**至少留多少（世界像素）—— 不许为了避让又压回线上。 */
export const ANCHOR_KEEP_OUT = 3;

export interface Point {
  x: number;
  y: number;
}

/** 一条标注的排版决定：转不转、往哪边让。 */
export interface LabelPlacement {
  /** 绕标签中心的旋转角（弧度）。竖线上的长标注转 `-π/2`（自下而上读，ISO 惯例）。 */
  angle: number;
  /** 基准位（相对折线锚点，世界单位）。 */
  base: [number, number];
  /** 判定时实际采用的那条腿（诊断 / e2e 用）。 */
  vertical: boolean;
  segmentLength: number;
}

export interface Segment {
  dx: number;
  dy: number;
  length: number;
  /** 锚点到这段的垂距。 */
  distance: number;
  vertical: boolean;
}

/**
 * 列出折线上**贴着锚点**的那几段（垂距在最小值 + `tolerance` 以内）。
 *
 * 为什么是"几段"而不是"一段"：本仓的折线是曼哈顿走向，锚点（引擎 `getLabelPosition()`
 * 取的中段折点）几乎总是落在**拐点**上 —— 实测 100 条标注全是拐点，横竖两条腿与锚点等距。
 * 只取一段就得靠"谁先出现"决定，等于把排版交给数组顺序（也正好是我们之前一条都没转的原因：
 * 先遍历到的总是横腿）。
 */
export function touchingSegments(points: Point[], anchor: Point, tolerance = 1.5): Segment[] {
  const all: Segment[] = [];
  for (let i = 1; i < (points?.length || 0); i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    // 点到线段的垂距（投影夹到 [0,1]，端点上就是点到端点的距离）
    const t = Math.max(0, Math.min(1, ((anchor.x - a.x) * dx + (anchor.y - a.y) * dy) / (len * len)));
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    const dist = Math.hypot(anchor.x - px, anchor.y - py);
    all.push({ dx, dy, length: len, distance: dist, vertical: Math.abs(dy) > Math.abs(dx) });
  }
  if (!all.length) return [];
  const min = Math.min(...all.map((s) => s.distance));
  return all.filter((s) => s.distance <= min + tolerance);
}

/**
 * 算一条标注的**排版**：默认离线（贴在管子旁边），竖线上的长标注再转 90°。
 *
 * 规则（固定 → 结果可复现）：
 *
 * | 情况 | 角度 | 基准位 |
 * |---|---|---|
 * | 水平段（`|dx| ≥ |dy|`） | 0（横排） | 往上让 `盒半高 + 4` |
 * | **竖段且装得下**（段长 ≥ 盒宽 + 2×间隙） | **-90°**（自下而上读） | 往右让 `盒半高 + 4` |
 * | 竖段但太短 | 0 | 往上让 `盒半高 + 4` |
 * | 找不到折线 | 0 | 不平移 |
 *
 * 为什么竖段要**转**：横排时盒宽就是字宽（实测一条 `DN1000 污水` 是 79px），
 * 不论往左还是往右挪都可能仍然压着线（往右挪 12px 之后左边还有 28px 盖在线上）；
 * 转 90° 之后盒子在横向只剩字高，挪一点点就完全离开线条，而且文字顺着管子读。
 * 转过去之后"往右让"的量正好是**未旋转盒子的半高**（旋转后它成了横向半宽）。
 *
 * 为什么短竖段**不转**：转过去字会戳出管子两头，比横排更难看 —— 判定就是"段长装得下"。
 *
 * ⚠️ 为什么用"离锚点最近的那段"而不是"第 i 段"：锚点由引擎的 `getLabelPosition()` 定
 * （2 点取中点、多点取中间折点），在这里把那条规则再抄一份就等着漂移。
 * 拿引擎给的锚点反查最近的段，既不用抄规则，折点处（两段相交）也自然取到其中一段。
 */
export function planLabelPlacement(
  points: Point[],
  anchor: Point,
  box: { w: number; h: number },
  gap = LABEL_EDGE_GAP
): LabelPlacement {
  const touching = touchingSegments(points, anchor);
  if (!touching.length) return { angle: 0, base: [0, 0], vertical: false, segmentLength: 0 };
  const longest = (list: Segment[]) => list.slice().sort((a, b) => b.length - a.length)[0];

  /**
   * **竖腿优先**：拐点上横竖两条腿都与锚点等距，只要竖的那条装得下标注
   * （`段长 ≥ 盒宽 + 2×间隙`），就转 90° 顺着它排 —— 这正是"竖线上的长标注应当竖排"
   * 那条意见（实测本仓 100 条标注全在拐点上，其中 57 条有一条长竖腿，最长 1290px）。
   * 转过去之后横向半宽就是**未旋转盒的半高**，所以往右让 `盒半高 + 间隙` 就完全离开线条。
   */
  const fittableVertical = longest(touching.filter((s) => s.vertical && s.length >= box.w + gap * 2));
  if (fittableVertical) {
    return {
      angle: -Math.PI / 2,
      base: [box.h / 2 + gap, 0],
      vertical: true,
      segmentLength: fittableVertical.length,
    };
  }

  // 其余情况横排、往上让（盒子下缘离线条 `gap`）。
  const seg = longest(touching);
  return { angle: 0, base: [0, -(box.h / 2 + gap)], vertical: seg.vertical, segmentLength: seg.length };
}

/**
 * 候选位移：**最近优先**，方向按"远离撞得最狠的那个障碍"排。
 * 第一个候选永远是"基准位"（有 `base` 就是默认法向错开量，没有就是 `[0, 0]` 原位），
 * 所以"在基准位就不撞"的标注只做默认错开、不会被无谓地推更远。
 */
function candidates(
  label: Box,
  obstacles: Box[],
  step: number,
  maxSteps: number
): Array<[number, number]> {
  let worst: { box: Box; ov: number } | null = null;
  for (const o of obstacles) {
    const ov = intersection(label, o);
    if (ov > 0 && (!worst || ov > worst.ov)) worst = { box: o, ov };
  }

  const dirs: Array<[number, number]> = [];
  if (worst) {
    const [lx, ly] = centerOf(label);
    const [ox, oy] = centerOf(worst.box);
    const dx = lx - ox;
    const dy = ly - oy;
    // 主方向先走"离开障碍"的那一侧；两个轴的符号都取"往外"，
    // 分不出来（正好同心）时按"先上后下、先右后左"的固定顺序，保证结果可复现。
    if (Math.abs(dy) >= Math.abs(dx)) {
      dirs.push([0, dy >= 0 ? 1 : -1], [0, dy >= 0 ? -1 : 1], [1, 0], [-1, 0]);
    } else {
      dirs.push([dx >= 0 ? 1 : -1, 0], [dx >= 0 ? -1 : 1, 0], [0, 1], [0, -1]);
    }
  } else {
    dirs.push([0, -1], [0, 1], [1, 0], [-1, 0]);
  }

  const out: Array<[number, number]> = [[0, 0]];
  for (let k = 1; k <= maxSteps; k++) {
    for (const [ux, uy] of dirs) out.push([ux * k * step, uy * k * step]);
  }
  return out;
}

/**
 * 给每条标注算一个位移。
 *
 * 返回**每一条**非 pinned 标注的位移（包括 `[0, 0]`）—— 调用方按它无条件写入，
 * 这样"图变了之后原来挪开的标注能自动回位"，不用再记一套状态。
 */
export function planLabelOffsets(input: LabelPlanInput): PlannedOffset[] {
  const step = input.step ?? 16;
  const maxSteps = Math.max(1, input.maxSteps ?? 4);
  const minRatio = input.minRatio ?? 0.02;
  const blocked = (box: Box, seen: Box[]): boolean =>
    seen.some((s) => overlapRatio(box, s) >= minRatio);
  /** 候选位是否"压回了自己那根线"（只在调用方给了锚点时生效）。 */
  const onOwnLine = (anchor: Point | undefined, box: Box): boolean =>
    !!anchor && pointBoxDistance(anchor, box) < ANCHOR_KEEP_OUT;

  const placedUnits = input.units.slice();
  const placedLabels: Box[] = [];
  const out: PlannedOffset[] = [];

  for (const pinned of input.pinned ?? []) {
    placedLabels.push({ ...pinned.box });
  }

  for (const label of input.labels) {
    const base: [number, number] = label.base ? [label.base[0], label.base[1]] : [0, 0];
    /**
     * 候选排版：给了 `placements` 就按它的顺序（每种自带角度与"基准位下的盒子"），
     * 否则退回老行为 —— 单一位移候选（`base` + 位移、角度 0）。
     */
    const options = label.placements?.length
      ? label.placements
      : [{ angle: 0, base, box: shifted(label, base) }];

    let chosen: { offset: [number, number]; angle: number } = { offset: options[0].base, angle: options[0].angle };
    let bestCost = Number.POSITIVE_INFINITY;
    outer: for (const option of options) {
      for (const delta of candidates(option.box, placedUnits, step, maxSteps)) {
        const box = shifted(option.box, delta);
        if (onOwnLine(label.anchor, box)) continue;
        const offset: [number, number] = [option.base[0] + delta[0], option.base[1] + delta[1]];
        if (!blocked(box, placedUnits) && !blocked(box, placedLabels)) {
          chosen = { offset, angle: option.angle };
          bestCost = 0;
          break outer;
        }
        const cost =
          placedUnits.reduce((sum, u) => sum + overlapRatio(box, u), 0) +
          placedLabels.reduce((sum, p) => sum + overlapRatio(box, p), 0);
        if (cost < bestCost) {
          bestCost = cost;
          chosen = { offset, angle: option.angle };
        }
      }
    }
    const option = options.find((o) => o.angle === chosen.angle) || options[0];
    placedLabels.push(shifted(option.box, [chosen.offset[0] - option.base[0], chosen.offset[1] - option.base[1]]));
    out.push({ id: label.id, offset: chosen.offset, angle: chosen.angle });
  }

  return out;
}

/**
 * 把一次排版判定展开成**候选排版列表**（按偏好排序）：首选朝向在前，另一个在后。
 *
 * 为什么要有备选：竖排让标注变"横窄竖高"（108×28 → 28×108），在窄走廊里（两边分别是
 * 另一条标注和池体，只剩十几像素）反而放不下；那时应当**退回横排**而不是把竖排推到很远
 * —— 求解器会把每个候选的位移都试一遍，谁先落得下用谁。
 *
 * ⚠️ 盒子按"该朝向、该基准位"给（不是零偏移）：`w / h` 是**未旋转**的盒子尺寸，
 * 转 90° 之后横向半宽变成 `h / 2`、纵向半高变成 `w / 2`。
 */
export function buildPlacements(
  anchor: Point,
  w: number,
  h: number,
  placement: LabelPlacement,
  gap = LABEL_EDGE_GAP
): Array<{ angle: number; base: [number, number]; box: Box }> {
  const centered = (centerX: number, centerY: number, halfW: number, halfH: number): Box => ({
    minX: centerX - halfW,
    minY: centerY - halfH,
    maxX: centerX + halfW,
    maxY: centerY + halfH,
  });
  const rotated = { angle: -Math.PI / 2, base: [h / 2 + gap, 0] as [number, number] };
  const flat = { angle: 0, base: [0, -(h / 2 + gap)] as [number, number] };
  const withBox = (o: { angle: number; base: [number, number] }) => ({
    ...o,
    box: o.angle
      ? centered(anchor.x + o.base[0], anchor.y + o.base[1], h / 2, w / 2)
      : centered(anchor.x + o.base[0], anchor.y + o.base[1], w / 2, h / 2),
  });
  return placement.angle ? [withBox(rotated), withBox(flat)] : [withBox(flat)];
}
