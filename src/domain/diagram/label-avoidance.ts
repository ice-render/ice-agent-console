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

export const shifted = (b: Box, offset: [number, number]): Box => ({
  minX: b.minX + offset[0],
  minY: b.minY + offset[1],
  maxX: b.maxX + offset[0],
  maxY: b.maxY + offset[1],
});

const centerOf = (b: Box): [number, number] => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];

/**
 * 候选位移：**最近优先**，方向按"远离撞得最狠的那个障碍"排。
 * 第一个候选永远是 `[0, 0]`（原位），所以"本来就不撞"的标注不会被无谓地挪走。
 */
function candidates(label: Box, obstacles: Box[], step: number, maxSteps: number): Array<[number, number]> {
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

  const placedUnits = input.units.slice();
  const placedLabels: Box[] = [];
  const out: PlannedOffset[] = [];

  for (const pinned of input.pinned ?? []) {
    placedLabels.push({ ...pinned.box });
  }

  for (const label of input.labels) {
    let chosen: [number, number] = [0, 0];
    let bestCost = Number.POSITIVE_INFINITY;
    for (const offset of candidates(label, placedUnits, step, maxSteps)) {
      const box = shifted(label, offset);
      if (!blocked(box, placedUnits) && !blocked(box, placedLabels)) {
        chosen = offset;
        bestCost = 0;
        break;
      }
      const cost =
        placedUnits.reduce((sum, u) => sum + overlapRatio(box, u), 0) +
        placedLabels.reduce((sum, p) => sum + overlapRatio(box, p), 0);
      if (cost < bestCost) {
        bestCost = cost;
        chosen = offset;
      }
    }
    placedLabels.push(shifted(label, chosen));
    out.push({ id: label.id, offset: chosen });
  }

  return out;
}
