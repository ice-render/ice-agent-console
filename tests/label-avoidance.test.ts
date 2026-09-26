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
import {
  LABEL_EDGE_GAP,
  LABEL_CLEARANCE,
  planLabelPlacement,
  planLabelOffsets,
  overlapRatio,
  shifted,
  type Box,
} from '../src/domain/diagram/label-avoidance';

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
    expect(planLabelOffsets({ units, labels })).toEqual([{ id: 'a', offset: [0, 0], angle: 0 }]);
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

  /**
   * ★ **最受限优先**（fail-first，经典 LPL 启发式）：候选最少的标注先放。
   *
   * 为什么值得：真实案例上的离线单因子实验（`docs/label-placement-notes.md` 有表）
   * 只加这一条就把**最大位移从 81.2 降到 65.5 世界像素**（重叠仍是 0/0）。
   *
   * 这条用例把机制本身钉住：灵活的标注若先放、占掉了挑剔标注的唯一空位，
   * 挑剔的那条就会被推到很远；反过来（先放挑剔的）两条都只需小幅移动。
   */
  test('★ 灵活的先放会挤走挑剔的 → 应当让"候选最少的"先放', () => {
    // 墙把空间分成三格：x ∈ [-200,0] / [0,100] / [100,300]，中间那格只够放一个标注
    const wallLeft = box(-400, -400, 200, 800);      // 左侧墙
    const wallRight = box(100, -400, 200, 800);      // 右侧墙
    const units: Box[] = [];
    // 挑剔的：基准位正好落在"中间那格"，只能往左或往右挪出这格
    const picky = { ...label('picky', 10, 0, 70, 20), anchor: { x: 45, y: 10 } };
    // 灵活的：附近空得很（哪边都能挪）
    const flexible = { ...label('flexible', 210, 0, 70, 20), anchor: { x: 245, y: 10 } };
    const plans = planLabelOffsets({ units: [wallLeft, wallRight], labels: [flexible, picky], step: 16, maxSteps: 6 });
    const byId = new Map(plans.map((p) => [p.id, p.offset]));
    // 挑剔的只用小幅位移（它先挑位置），灵活的承担剩下的
    expect(Math.hypot(...byId.get('picky')!)).toBeLessThanOrEqual(16);
    expect(overlapsAfter([wallLeft, wallRight], [flexible, picky], plans).vsUnits).toBe(0);
    // 反过来把它放在最后（输入顺序无关紧要）—— 结果必须一样
    const plans2 = planLabelOffsets({ units: [wallLeft, wallRight], labels: [picky, flexible], step: 16, maxSteps: 6 });
    const byId2 = new Map(plans2.map((p) => [p.id, p.offset]));
    expect(Math.hypot(...byId2.get('picky')!)).toBeLessThanOrEqual(16);
  });

  test('退化盒（宽或高为 0）不算撞 —— 别被零面积的对象骗到', () => {
    const units = [box(0, 0, 0, 0)];
    const labels = [label('a', 0, 0)];
    expect(planLabelOffsets({ units, labels })[0].offset).toEqual([0, 0]);
  });

  /**
   * ★ **默认排版**（2026-09-26 加）：标注贴在管子旁边，而不是压在管子上；
   * **竖线上的长标注转 90°**（自下而上读）顺着管子走 —— 横排时盒宽就是字宽，
   * 无论往左还是往右挪都可能仍然压着线。
   */
  describe('默认排版：贴在旁边；竖线长标注转 90°', () => {
    const points = (...pairs: Array<[number, number]>) => pairs.map(([x, y]) => ({ x, y }));
    /** 一个 108 × 28 的标注盒（≈ 14 号字、5 个字符那条 `DN1000 污水`） */
    const size = { w: 108, h: 28 };
    const up = [0, -(size.h / 2 + LABEL_EDGE_GAP)] as [number, number];

    test('水平段 → 横排、往上让（盒下缘离线 4px）', () => {
      const seg = points([0, 100], [200, 100]);
      expect(planLabelPlacement(seg, { x: 100, y: 100 }, size)).toMatchObject({ angle: 0, base: up });
    });

    test('★ 竖段且装得下 → 转 -90°、往右让（横排时盒子仍然压着线，转完只剩字高）', () => {
      const seg = points([50, 0], [50, 400]);                       // 400 ≥ 108 + 8
      expect(planLabelPlacement(seg, { x: 50, y: 200 }, size)).toMatchObject({
        angle: -Math.PI / 2,
        base: [size.h / 2 + LABEL_EDGE_GAP, 0],
        vertical: true,
      });
    });

    test('竖段但太短 → 不转（转了字会戳出管子两头），照旧往上让', () => {
      const seg = points([50, 0], [50, 80]);                        // 80 < 108 + 8
      expect(planLabelPlacement(seg, { x: 50, y: 40 }, size)).toMatchObject({ angle: 0, base: up });
    });

    test('斜段按主轴归并（曼哈顿走向下这条几乎不触发）', () => {
      const flat = points([0, 0], [200, 60]);
      expect(planLabelPlacement(flat, { x: 100, y: 30 }, size).angle).toBe(0);
      const steep = points([0, 0], [60, 200]);
      expect(planLabelPlacement(steep, { x: 30, y: 100 }, size).angle).toBe(-Math.PI / 2);
    });

    test('★ 锚点在拐点上（横竖两腿等距）→ 竖腿装得下就转，不能交给数组顺序', () => {
      // 曼哈顿折线：先横（100px）后竖（400px），锚点落在拐点上 —— 两段到锚点距离都是 0
      const folded = points([0, 100], [100, 100], [100, 500]);
      expect(planLabelPlacement(folded, { x: 100, y: 100 }, size)).toMatchObject({
        angle: -Math.PI / 2,
        vertical: true,
      });
      // 反过来：竖腿太短（80 < 108 + 8）→ 退回横排，按更长的那条腿（这里是 100px 的横腿）办
      const shortVertical = points([0, 100], [100, 100], [100, 180]);
      expect(planLabelPlacement(shortVertical, { x: 100, y: 100 }, size)).toMatchObject({
        angle: 0,
        vertical: false,
        segmentLength: 100,
      });
    });

    test('没有折线（点数不足）→ 不平移，别硬编一个方向', () => {
      expect(planLabelPlacement([], { x: 0, y: 0 }, size)).toMatchObject({ angle: 0, base: [0, 0] });
      expect(planLabelPlacement(points([1, 1]), { x: 1, y: 1 }, size)).toMatchObject({ angle: 0, base: [0, 0] });
    });

    test('★ 基准位（base）参与求解：本来就撞不着 + 有默认净距 → 结果就是那个净距', () => {
      const units: Box[] = [box(0, 0, 100, 20)];
      const labels = [{ ...label('a', 0, 200), base: up }];
      const [plan] = planLabelOffsets({ units, labels });
      expect(plan.offset).toEqual(up);
    });

    test('★ 首选朝向放不下 → 退回备选朝向（竖排被窄走廊卡住时退回横排）', () => {
      // 锚点 (100,100)、盒 108×28、间隙 4：
      //   横排盒 = x[46,154] y[68,96]；竖排盒 = x[104,132] y[46,154]
      // 障碍墙 = x[100,200] y[130,300]：只压竖排（横排的 y 够不着它）。
      // 用 maxSteps=1 把搜索限制在 ±16，让竖排确实无处可去 —— 此时必须退回横排。
      const anchor = { x: 100, y: 100 };
      const w = 108;
      const h = 28;
      const gap = 4;
      const flatBox = {
        minX: anchor.x - w / 2,
        minY: anchor.y - h / 2 - gap,
        maxX: anchor.x + w / 2,
        maxY: anchor.y + h / 2 - gap,
      };
      const rotatedBox = {
        minX: anchor.x + h / 2 + gap - h / 2,
        minY: anchor.y - w / 2,
        maxX: anchor.x + h / 2 + gap + h / 2,
        maxY: anchor.y + w / 2,
      };
      const units: Box[] = [box(100, 130, 100, 170)];
      const labels = [
        {
          id: 'a',
          minX: anchor.x - 1,
          minY: anchor.y - 1,
          maxX: anchor.x + 1,
          maxY: anchor.y + 1,
          placements: [
            { angle: -Math.PI / 2, base: [h / 2 + gap, 0] as [number, number], box: rotatedBox },
            { angle: 0, base: [0, -(h / 2 + gap)] as [number, number], box: flatBox },
          ],
        },
      ];
      const [plan] = planLabelOffsets({ units, labels, step: 16, maxSteps: 1 });
      expect(plan.angle).toBe(0);                                   // 退回了横排
      expect(plan.offset).toEqual([0, -(h / 2 + gap)]);              // 而且是横排的基准位
      expect(overlapsAfter(units, labels, [plan]).vsUnits).toBe(0);
    });

    test('★ 基准位本身压着东西 → 在基准位基础上继续推（不是退回原位）', () => {
      const units: Box[] = [box(0, 188, 100, 20)];                     // 正好压住 base 之后的标注
      const labels = [{ ...label('a', 0, 200), base: up }];
      const [plan] = planLabelOffsets({ units, labels });
      expect(plan.offset[1]).not.toBe(up[1]);
      expect(overlapsAfter(units, labels, [plan]).vsUnits).toBe(0);
    });
  });
});
