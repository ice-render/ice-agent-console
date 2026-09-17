/**
 * **讲解台词与工艺图对不上** —— 这条测试专门盯它。
 *
 * 为什么需要：图与台词是**两份手写数据**，而它们唯一的一致性判据只有"规模数字"
 * （那份在 `seo.test.ts` / `scripted.test.ts` 里）。设备层面没人管，于是实测漂过两次：
 *
 * | 漂法 | 表现 |
 * |---|---|
 * | 图上画了、台词从不点名 | 粗格栅与配水井画在第 2、8 格，11 站台词一次没提 |
 * | 新加的设备没有对应的一站 | 补上中间提升泵之后，它进了主流程链，台词里却一个字没有 —— 镜头走过去、嘴上没话说 |
 *
 * 判据两条，都是"硬"的（不靠人工比对）：
 * 1. **每个 `pointAt` 都指向图上存在的单元** —— 打错一个 id，镜头会指到虚空，而且不报错；
 * 2. **主流程链上的"处理单元"必须被台词点得到**（被某一站 `pointAt`，或在某句台词里点名）。
 *    仪表 / 阀门 / 边界不算"处理单元"—— 它们由所在那一站顺带讲，各自不需要一站。
 */
import { WATER_PROCESS_DSL, MAIN_FLOW_IDS } from '../shared/water-process-case';
import { WATER_WALK_BEATS } from '../server/agents/scenarios';

/** 只需要"顺带讲"的种类：仪表、阀门、边界。 */
const NON_UNIT_KINDS = new Set([
  'inlet',
  'outlet',
  'sludgeOut',
  'analyzer',
  'flowMeter',
  'levelGauge',
  'pressureGauge',
  'valve',
  'motorValve',
  'checkValve',
]);

describe('讲解台词 × 工艺图', () => {
  it('每个 pointAt 都指向图上存在的单元（打错 id 不会静默）', () => {
    const ids = new Set(WATER_PROCESS_DSL.units.map((u) => u.id));
    const missing = WATER_WALK_BEATS.filter((b) => b.pointAt && !ids.has(b.pointAt)).map(
      (b) => `pointAt: ${b.pointAt}`
    );
    expect(missing).toEqual([]);
  });

  it('★ 主流程上的处理单元，台词必须点得到（pointAt 或点名都算）', () => {
    const byId = new Map(WATER_PROCESS_DSL.units.map((u) => [u.id, u]));
    const pointed = new Set(WATER_WALK_BEATS.map((b) => b.pointAt).filter(Boolean));
    const narration = WATER_WALK_BEATS.map((b) => b.text).join('\n');

    const uncovered = MAIN_FLOW_IDS.filter((id) => {
      const unit = byId.get(id);
      if (!unit) return false; // 交给上一条用例去报
      if (NON_UNIT_KINDS.has(unit.kind)) return false;
      if (pointed.has(id)) return false;
      return !(unit.name && narration.includes(unit.name));
    });

    expect(uncovered.map((id) => `${id}（${byId.get(id)?.name ?? '?'}）没有被讲到`)).toEqual([]);
  });

  it('两组"现实回路"必须讲出来（画了不讲等于白画）', () => {
    const narration = WATER_WALK_BEATS.map((b) => b.text).join('\n');
    // 滤池反冲洗（反洗水回配水井）/ 污泥上清液与脱水滤液回流
    expect({ 讲了反冲洗: /反冲洗/.test(narration) }).toEqual({ 讲了反冲洗: true });
    expect({ 讲了回流水: /上清液/.test(narration) && /滤液/.test(narration) }).toEqual({
      讲了回流水: true,
    });
  });
});
