/**
 * 布局沙盘：离线试参数（缩放 + 逐 id 覆写），跑模型看还剩几处问题。
 * 不是为了提交，是为了把"改坐标"从反复开浏览器变成秒级迭代。
 */
import { analyze } from './layout-model.mjs';

export function respace(units, { xs = 1.4, ys = 1.4, overrides = {}, roundTo = 5 } = {}) {
  const r = (v) => Math.round(v / roundTo) * roundTo;
  return units.map((u) => {
    const o = overrides[u.id];
    return {
      ...u,
      left: o?.left ?? r(u.left * xs),
      top: o?.top ?? r(u.top * ys),
    };
  });
}

export function report(label, units, { gap = 20 } = {}) {
  const { overlaps, near } = analyze(units, { ratio: 0.02, gap });
  console.log(
    label.padEnd(28) +
      ' 重叠 ' + String(overlaps.length).padStart(2) +
      ' | 贴太近 ' + String(near.length).padStart(2) +
      (overlaps.length ? '   ' + overlaps.map((o) => o.a + '✕' + o.b).join(', ') : '') +
      (near.length ? '   [近] ' + near.map((n) => n.a + '✕' + n.b).join(', ') : '')
  );
  return { overlaps, near };
}
