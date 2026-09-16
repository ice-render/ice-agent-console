/**
 * **图元会不会叠在一起** —— 纯逻辑，可以直接单测。
 *
 * ## 为什么需要它
 *
 * 画面上有三种"叠"，前面几种手段都抓不到：
 *
 * | 叠法 | 谁该抓到 | 实际抓到没有 |
 * |---|---|---|
 * | 数量不对 | `diagramStats()` / e2e | 抓得到 |
 * | 整张图被裁到框外 | `viewportInfo()` + `fit` 那条用例 | 抓得到 |
 * | **图元之间互相压住** | —— | **谁都没抓**，只有人眼看得见 |
 *
 * 而且第二种和第三种容易混：我把"全貌档不裁"修好之后，图上仍然有符号压着文字 ——
 * 因为那两个盒子是**各自独立**算的，都在框里，框也装得下，只是彼此交叠。
 * `validateWater()` 更不管这件事，它只管工艺语义（位号唯一、管线有介质…）。
 *
 * ## 为什么不能只用引擎的 `getMinBoundingBox()`
 *
 * 它算的是**组件自己**的盒子（`__localBox()`），**不含子节点**。而位号与名称是**子节点**
 * （`ICEText`），并且刻意画在盒子**外面**：
 *
 * ```
 *          ┌─ 位号：顶边外侧居中，文字盒 top = -18，高 round(9.5 × 1.4) = 13
 *      ┌───────┐
 *      │ 符号   │      ← 形状盒（预设 w × h）
 *      └───────┘
 *          └─ 名称：底边外侧居中，文字盒 top = h + 14，高 round(12 × 1.4) = 17
 * ```
 *
 * 两者的宽度都是 `max(w + 24, 90)` 并水平居中 —— **对窄符号这一条最要紧**：
 * 一个 32 宽的阀门，它的文字盒有 **90 宽**，左右各溢出 29px。
 * 所以"图元叠没叠"必须按 `形状 ∪ 位号 ∪ 名称` 的**落墨盒**算。
 *
 * ⚠️ 我第一版就是拿 `getMinBoundingBox()` 量的，得出"0 处重叠"——
 * 而肉眼看得很清楚有几处压在一起。模型改对之后，量出来 3 处真重叠 + 4 处只差 1~11px。
 *
 * ⚠️ 保持这个模型与上游同步：那三个常数抄自 `ice-entity-designer` 的
 * `water_shapes.ts` `syncShape()` 末尾的排版。上游若改了字号或 `labelWidth` 公式，
 * 这里要跟着改 —— 否则这个测试会开始说假话（而且它会说"没问题"）。
 */
import { WATER_SYMBOL_PRESETS } from 'ice-entity-designer';
import type { WaterProcessUnit } from '../../../shared/diagram';

/** 位号文字盒：顶边外侧。 */
const TAG_TOP = -18;
const TAG_FONT = 9.5;
const TAG_H = Math.round(TAG_FONT * 1.4);
/** 名称文字盒：底边外侧。 */
const NAME_TOP_PAD = 14;
const NAME_FONT = 12;
const NAME_H = Math.round(NAME_FONT * 1.4);
/** 文字盒宽度：`max(w + 24, 90)`，水平居中。 */
const labelWidthOf = (w: number) => Math.max(w + 24, 90);

export interface InkBox {
  id: string;
  kind: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 一个单元**画出来实际占了哪一块**（形状 + 位号 + 名称的并集）。 */
export function inkBoxOf(unit: WaterProcessUnit): InkBox {
  const preset: any = (WATER_SYMBOL_PRESETS as any)[unit.kind] || {};
  const w = Number(preset.width) || 0;
  const h = Number(preset.height) || 0;
  const labelW = labelWidthOf(w);
  const labelLeft = unit.left + w / 2 - labelW / 2;

  const minX = Math.min(unit.left, labelLeft);
  const maxX = Math.max(unit.left + w, labelLeft + labelW);
  const minY = Math.min(unit.top, unit.top + TAG_TOP);
  const maxY = Math.max(unit.top + h, unit.top + h + NAME_TOP_PAD + NAME_H);
  return { id: unit.id, kind: unit.kind, minX, minY, maxX, maxY };
}

export interface OverlapPair {
  a: string;
  b: string;
  /** 交叠的宽 / 高（世界像素）。 */
  ox: number;
  oy: number;
  /** 交叠面积 ÷ 两个盒子中**较小**那个的面积。1 = 小的完全被压住。 */
  ratio: number;
}

export interface NearPair {
  a: string;
  b: string;
  /** 两个方向的空隙（世界像素）。>0 是分开，<0 是交叠。 */
  dx: number;
  dy: number;
}

/**
 * 找出所有**落墨盒交叠**的单元对。
 *
 * @param minRatio 交叠面积占比低于它就忽略（"边挨着边"不该算叠）。
 */
export function findOverlaps(units: WaterProcessUnit[], minRatio = 0.02): OverlapPair[] {
  const boxes = units.map(inkBoxOf);
  const out: OverlapPair[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
      if (ox <= 0 || oy <= 0) continue;
      const areaA = (a.maxX - a.minX) * (a.maxY - a.minY);
      const areaB = (b.maxX - b.minX) * (b.maxY - b.minY);
      const ratio = (ox * oy) / Math.min(areaA, areaB);
      if (ratio < minRatio) continue;
      out.push({ a: a.id, b: b.id, ox: Math.round(ox), oy: Math.round(oy), ratio: +ratio.toFixed(3) });
    }
  }
  return out.sort((x, y) => y.ratio - x.ratio);
}

/**
 * 找出**贴得太近**的单元对：两个方向的空隙都小于 `minGap`。
 *
 * 为什么要单独一条（不只是"没重叠就算过"）：两个盒子只差 1px 挨着，
 * 视觉上仍然是"挤在一起"，而且**稍微改一点数据就会变成重叠**。
 * 1px 那种是实测踩到的（`aer1` 与它下面的溶解氧仪表、`accidentTank` 与液位计）。
 */
export function findTightPairs(units: WaterProcessUnit[], minGap = 20): NearPair[] {
  const boxes = units.map(inkBoxOf);
  const out: NearPair[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const dx = Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX);
      const dy = Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY);
      // 只要有一个方向分得够开就不算挤（比如左右相隔很远的两行）
      if (dx >= minGap || dy >= minGap) continue;
      out.push({ a: a.id, b: b.id, dx: Math.round(dx), dy: Math.round(dy) });
    }
  }
  return out.sort((x, y) => Math.max(x.dx, x.dy) - Math.max(y.dx, y.dy));
}

/**
 * 世界里"全部落墨"的包围盒 —— 布局宽松度的直接读数。
 *
 * 用它的**面积 ÷ 单元数**当"每单元摊到多少世界面积"，比看单条间隙更能说明
 * "整张图松了还是挤了"。无限画布上这个数只该变大。
 */
export function inkExtent(units: WaterProcessUnit[]): { width: number; height: number; area: number } {
  const boxes = units.map(inkBoxOf);
  if (!boxes.length) return { width: 0, height: 0, area: 0 };
  const width = Math.max(...boxes.map((b) => b.maxX)) - Math.min(...boxes.map((b) => b.minX));
  const height = Math.max(...boxes.map((b) => b.maxY)) - Math.min(...boxes.map((b) => b.minY));
  return { width, height, area: width * height };
}
