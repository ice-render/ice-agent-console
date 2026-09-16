/**
 * 离线量重叠（不启浏览器）。
 *
 * 模型来自 `ice-entity-designer` 的 `water_shapes.ts` `syncShape()` 末尾那段排版：
 *   - 位号：符号**顶边外侧**居中，文字盒 top = -18，height = round(9.5 * 1.4) = 13
 *   - 名称：符号**底边外侧**居中，文字盒 top = h + 14，height = round(12 * 1.4) = 17
 *   - 两者宽度都是 `max(w + 24, 90)`，水平居中
 * 于是落墨盒 = 形状盒 ∪ 这两个文字盒。
 *
 * ⚠️ 这个模型必须先**与浏览器实测对得上**再用它迭代布局（见 calibrate 输出）。
 */
// 家族包不在 node_modules 里（走 alias / moduleNameMapper），所以直接引兄弟仓的产物。
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const { WATER_SYMBOL_PRESETS } = require_('../../ice-entity-designer/dist/index.cjs');

const TAG_TOP = -18;
const TAG_H = Math.round(9.5 * 1.4);   // 13
const NAME_TOP_PAD = 14;
const NAME_H = Math.round(12 * 1.4);   // 17
const MIN_LABEL_W = 90;

export function inkBoxOf(u) {
  const p = WATER_SYMBOL_PRESETS[u.kind] || {};
  const w = p.width ?? 0;
  const h = p.height ?? 0;
  const shapeMinX = u.left;
  const shapeMinY = u.top;
  const shapeMaxX = u.left + w;
  const shapeMaxY = u.top + h;

  const labelW = Math.max(w + 24, MIN_LABEL_W);
  const labelLeft = u.left + w / 2 - labelW / 2;

  const boxes = [
    [shapeMinX, shapeMinY, shapeMaxX, shapeMaxY],
    [labelLeft, u.top + TAG_TOP, labelLeft + labelW, u.top + TAG_TOP + TAG_H],
    [labelLeft, u.top + h + NAME_TOP_PAD, labelLeft + labelW, u.top + h + NAME_TOP_PAD + NAME_H],
  ];
  return {
    id: u.id,
    kind: u.kind,
    minX: Math.min(...boxes.map((b) => b[0])),
    minY: Math.min(...boxes.map((b) => b[1])),
    maxX: Math.max(...boxes.map((b) => b[2])),
    maxY: Math.max(...boxes.map((b) => b[3])),
  };
}

/** 真重叠（交叠面积 > 小盒 ratio）+ 贴太近（两个方向空隙都 < gap）。 */
export function analyze(units, { ratio = 0.02, gap = 12 } = {}) {
  const boxes = units.map(inkBoxOf);
  const overlaps = [];
  const near = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const ox = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
      const oy = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
      if (ox > 0 && oy > 0) {
        const areaA = (a.maxX - a.minX) * (a.maxY - a.minY);
        const areaB = (b.maxX - b.minX) * (b.maxY - b.minY);
        const r = (ox * oy) / Math.min(areaA, areaB);
        if (r >= ratio) overlaps.push({ a: a.id, b: b.id, ox: Math.round(ox), oy: Math.round(oy), ratio: +r.toFixed(3) });
      } else {
        const dx = Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX);
        const dy = Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY);
        if (dx < gap && dy < gap) near.push({ a: a.id, b: b.id, dx: Math.round(dx), dy: Math.round(dy) });
      }
    }
  }
  overlaps.sort((x, y) => y.ratio - x.ratio);
  near.sort((x, y) => Math.max(x.dx, x.dy) - Math.max(y.dx, y.dy));
  return { boxes, overlaps, near };
}
