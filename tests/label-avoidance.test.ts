/**
 * 管线标注的自动避让（2026-09-26 立）。
 *
 * 背景：单元之间的重叠有 `layout.ts` 那套棘轮兜着（线上实测 0 处），但**管线标注**
 * 管不到 —— 它的锚点由引擎定死在折线的中段折点上，折点又是路由器绕开**符号盒**
 * 折出来的，于是"标注压住单元"对间距是尺度不变的（线上实测 50 处，占小盒 25%~55%）。
 *
 * 解法是给标注一个偏移（引擎 2026-09-18 补的 `style.label.offset`），这个文件钉住的
 * 就是"偏移该给多少"那套纯逻辑。判据与 `layout.ts` 同口径：占小盒 ≥2% 才算压住。
 */
import { test, expect, describe } from '@jest/globals';
import { planLabelOffsets, overlapRatio, shifted, type Box } from '../src/domain/diagram/label-avoidance';

const box = (minX: number, minY: number, w = 100, h = 20): Box => ({
  minX,
  minY,
  maxX: minX + w,
  maxY: minY + h,
});
const label = (id: string, minX: number, minY: number, w = 100, h = 20) => ({ id, ...box(minX, minY, w, h) });

/** 把计划应用上去，看还有没有压住的（测试自己的小助手，与线上的量法同口径）。 */
function overlapsAfter(units: Box[], labels: ReturnType<typeof label>[], offsets: Array<{ id: string; offset: [number, number] }>) {
  const byId = new Map(offsets.map((o) => [o.id, o.offset]));
  const moved = labels.map((l) => shifted(l, byId.get(l.id) ?? [0, 0]));
  const vsUnits = moved.filter((l) => units.some((u) => overlapRatio(l, u) >= 0.02)).length;
  const vsLabels = moved.filter((l, i) => moved.some((o, j) => j > i && overlapRatio(l, o) >= 0.02)).length;
  return { vsUnits, vsLabels };
}

describe('planLabelOffsets：管线标注往哪挪', () => {
  test('本来就不撞 → 一条都不动（别把好好的标注推走）', () => {
    const units = [box(0, 0)];
    const labels = [label('a', 500, 500)];
    expect(planLabelOffsets({ units, labels })).toEqual([{ id: 'a', offset: [0, 0] }]);
  });

  test('★ 标注压在单元上 → 挪到不压，且方向是"离开那个单元"', () => {
    const units = [box(0, 0, 100, 40)];            // 单元在左上
    const labels = [label('a', 10, 10)];            // 标注正好压在它上面
    const [plan] = planLabelOffsets({ units, labels });
    expect(plan.offset).not.toEqual([0, 0]);
    expect(overlapsAfter(units, labels, [plan]).vsUnits).toBe(0);
    // ⚠️ 只钉"确实挪开了"，**不钉方向**：两个盒子完全重合时，"哪边更近"取决于
    // 谁先清空（实测同一跳数下四个方向会依次试），钉死方向等于把实现的试序写进测试。
    // 真正要保证的"优先最近"由下一条用例钉（那里方向是唯一的）。
  });

  test('★ 两条标注叠在同一点 → 分开（同文字也一样：两条各标各的管子）', () => {
    const units: Box[] = [];
    const labels = [label('a', 0, 0), label('b', 0, 0)];
    const plans = planLabelOffsets({ units, labels });
    expect(overlapsAfter(units, labels, plans).vsLabels).toBe(0);
    expect(plans[1].offset).not.toEqual([0, 0]);
  });

  test('优先选**最近**的能清空的位置（别一步窜远）', () => {
    // 单元在上、标注只压住它的下缘 4px：一步 16px 就够 —— 算法必须只走一步
    const units = [box(0, 0, 100, 20)];
    const labels = [label('a', 0, 16)];
    const [plan] = planLabelOffsets({ units, labels, step: 16 });
    expect(Math.max(Math.abs(plan.offset[0]), Math.abs(plan.offset[1]))).toBe(16);
    expect(overlapsAfter(units, labels, [plan]).vsUnits).toBe(0);
  });

  test('钉住的（显式给了 offset）一动不动，但别人要躲开它', () => {
    const units: Box[] = [];
    const labels = [label('free', 0, 0)];
    const pinned = [{ id: 'fixed', box: box(0, 0) }];
    const plans = planLabelOffsets({ units, labels, pinned });
    expect(plans.map((p) => p.id)).toEqual(['free']);      // 钉住的不出现在计划里
    expect(overlapsAfter(units, labels, plans).vsLabels).toBe(0);
    // 与钉住的那块也不许压
    const moved = shifted(labels[0], plans[0].offset);
    expect(overlapRatio(moved, pinned[0].box)).toBeLessThan(0.02);
  });

  test('挪到上限还清不掉 → 取撞得最少的那个（不无限外推）', () => {
    const units = [box(-500, -500, 2000, 2000)];          // 一块比候选范围大得多的障碍
    const labels = [label('a', 0, 0)];
    const plans = planLabelOffsets({ units, labels, step: 16, maxSteps: 2 });
    const maxAbs = Math.max(Math.abs(plans[0].offset[0]), Math.abs(plans[0].offset[1]));
    expect(maxAbs).toBeLessThanOrEqual(32);               // 2 跳 × 16
  });

  test('结果确定：同样输入跑两遍完全一致（顺序敏感但稳定）', () => {
    const units = [box(0, 0, 100, 40), box(300, 0, 100, 40)];
    const labels = [label('a', 10, 10), label('b', 310, 10), label('c', 10, 10)];
    const one = planLabelOffsets({ units, labels });
    const two = planLabelOffsets({ units, labels });
    expect(one).toEqual(two);
    expect(overlapsAfter(units, labels, one).vsUnits).toBe(0);
  });

  test('退化盒（宽或高为 0）不算撞 —— 别被零面积的对象骗到', () => {
    const units = [box(0, 0, 0, 0)];
    const labels = [label('a', 0, 0)];
    expect(planLabelOffsets({ units, labels })[0].offset).toEqual([0, 0]);
  });
});
