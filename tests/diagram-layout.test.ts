/**
 * **工艺图的布局**：图元之间不许压住、也不许挤在一起。
 *
 * 见 `src/domain/diagram/layout.ts` 的文件头 —— 那里写了为什么这件事既不能靠
 * `validateWater()`（它只管工艺语义）、也不能靠引擎的 `getMinBoundingBox()`
 * （它不含画在盒外的位号与名称），而只能按**落墨盒**算。
 *
 * 这一组用例的价值在于：**把"图看着挤不挤"变成可断言的事实**。
 * 在这之前它是"改完坐标靠人眼睛扫一遍"——而人眼看不出 1px 的贴边，
 * 更看不出"改了 A 把 B 挤了"这种连带影响。
 */
import { findOverlaps, findTightPairs, inkExtent } from '../src/domain/diagram/layout';
import {
  UPGRADE_BRIDGE_PIPES,
  UPGRADE_PIPES,
  UPGRADE_REMOVED_PIPE_IDS,
  UPGRADE_REMOVED_UNIT_IDS,
  UPGRADE_UNITS,
  WATER_PROCESS_DSL,
} from '../shared/water-process-case';

const BASE_UNITS = WATER_PROCESS_DSL.units;

/** 失败时的可读描述（数组断言里用，jest 会把它们 diff 出来）。 */
const describeOverlap = (o: { a: string; b: string; ox: number; oy: number; ratio: number }) =>
  `${o.a} ✕ ${o.b} 交叠 ${o.ox}×${o.oy}（占小的 ${(o.ratio * 100).toFixed(0)}%）`;
const describeTight = (t: { a: string; b: string; dx: number; dy: number }) =>
  `${t.a} ✕ ${t.b} dx=${t.dx} dy=${t.dy}`;

/** 把「提标改造」那批补丁应用到单元表上（补丁本身在 scenarios 里编，这里只要结果）。 */
function upgradedUnits() {
  const bridge = UPGRADE_BRIDGE_PIPES.map((p) => p.id);
  const replaced = UPGRADE_REMOVED_PIPE_IDS;
  const drop = new Set(UPGRADE_REMOVED_UNIT_IDS);
  // 删单元要连带删挂在它身上的管线 —— 这里只关心单元，所以只过滤单元表
  const kept = BASE_UNITS.filter((u) => !drop.has(u.id));
  const extra = UPGRADE_UNITS.filter((u) => !kept.some((k) => k.id === u.id));
  void bridge;
  void replaced;
  return [...kept, ...extra];
}

describe('工艺图布局：图元不许压住', () => {
  it('★ 基础图：落墨盒之间零重叠', () => {
    // ⚠️ 断言直接比数组、不写 `expect(n, '消息')`（jest 的 expect 只吃一个参数）。
    // 好处不只是不报错：失败时 jest 会把**具体哪几对、交叠多少** diff 出来，
    // 比手拼一句消息还清楚。
    expect(findOverlaps(BASE_UNITS).map(describeOverlap)).toEqual([]);
  });

  it('★ 基础图：两两之间留出足够呼吸（两个方向都不许挤）', () => {
    // 只判"不重叠"不够：两盒只差 1px 挨着，看着仍然是挤的，
    // 而且稍微动一点数据就会变成重叠。1px 那种是实测踩到的。
    expect(findTightPairs(BASE_UNITS, 20).map(describeTight)).toEqual([]);
  });

  it('★ 提标改造**之后**的图也不许压住（那三个单元插进的是预留空位）', () => {
    const units = upgradedUnits();
    expect(findOverlaps(units).map(describeOverlap)).toEqual([]);
    expect(findTightPairs(units, 20).map(describeTight)).toEqual([]);
  });

  it('无限画布：布局要够宽松（每单元摊到的世界面积有个下限）', () => {
    // 这条是需求"把图元之间的距离再拉开一点，不要那么小气"的落点。
    // 用"总面积 ÷ 单元数"而不是"某两条之间的间隙"：前者能整体说明松紧，
    // 后者只盯一处、容易被"挪好这一对、挤坏另一对"绕过。
    const { area } = inkExtent(BASE_UNITS);
    const perUnit = Math.round(area / BASE_UNITS.length);
    // 实测：放宽前 176k（够挤的），放宽后 364k（×2.06）。
    // 门槛取 300k —— 高于旧值一大截（挡住回退），又给后续微调留了余量。
    expect({ perUnit, ok: perUnit >= 300_000 }).toEqual({ perUnit, ok: true });
  });

  it('单元数与种类没被布局改动弄丢', () => {
    expect(BASE_UNITS.length).toBe(68);
    expect(WATER_PROCESS_DSL.pipes.length).toBe(81);
    // id 唯一：布局时复制粘贴最容易带出重复 id（那会让管线指向第一个）
    const ids = BASE_UNITS.map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
