/**
 * **内置案例：某 10 万 m³/d 市政污水厂的 AAO 工艺流程**。
 *
 * 这份数据搬自 `ice-smart-water` 的 `src/domain/plant-case.ts`（那边是业务控制台，
 * 图只是它的一个页签）。搬过来的是**图本身**，不是那边的业务计算 ——
 * 原案例里的 `design`（水量 / 池容 / 功率 / 水头损失）与 `meta`（进出水指标、
 * 回流比…）是算 KPI 用的，画图用不到，所以这里只有几何与标注。
 *
 * 数据规模：**34 个单元 / 37 段管线**，用到 `ice-entity-designer` 的
 * **全部 31 种符号种类与全部 9 种介质** —— 这也是选它当第一个例子的原因：
 * 它把给排水工艺图这套记号系统整个跑了一遍，而不是挑几个符号摆一摆。
 *
 * ## 两件与"搬"有关的事，改之前先看
 *
 * 1. **坐标是绝对坐标，不是布局结果**。原案例里就是硬编码的（三行一列：水线主线 /
 *    深度处理 / 污泥线）。本工程不做自动布局 —— 强行自动排版会把图纸意图排没。
 * 2. **管线端口大多没写**（37 段里有 28 段）。不写时的兜底在
 *    `src/domain/diagram/compile.ts`，是 `R → L`（从左往右）而**不是**引擎默认的 `B → T`。
 *    写端口的那几段都是有讲究的（回流、超越管要绕行），别顺手删。
 *
 * ## 数据正确性怎么保证
 *
 * - 结构：`tests/diagram-dsl.test.ts`（白名单 / 引用完整性 / 端口兜底）
 * - 规模：`e2e/diagram.spec.ts` 断言 34 / 37
 * - **工艺语义**：`DiagramLayer.issues()` 走引擎的 `validateWater()`，断言零问题。
 *   同一条断言在 `ice-smart-water` 里也是零问题 —— 两边一致才说明搬的过程中没改语义。
 */
import type { WaterProcessDslDocument } from '../../shared/diagram';

/**
 * 主流程链（进水 → 生化 → 二沉 → 深度处理 → 排放）。
 *
 * 用来给初始视野一个焦点。图的世界宽度约 1454，卡片只有 ~872，
 * 整图适配会把位号文字压到 6~7px；所以要明确"先看哪儿"。
 * 这串 id 与原案例 `tests/domain/plant-graph.test.ts` 里断言的 17 节点主流程一致。
 */
export const MAIN_FLOW_IDS = [
  'inlet', 'pump', 'checkValve', 'screen', 'grit', 'primary',
  'ana', 'anx', 'aer', 'sec',
  'coag', 'filter', 'disinfect', 'analyzer', 'meter', 'outletValve', 'outlet',
];

export const WATER_PROCESS_DSL: WaterProcessDslDocument = {
  kind: 'water-process',
  title: 'AAO + 混凝沉淀 + 滤布滤池 + 消毒（10 万 m³/d）',
  viewport: { focus: MAIN_FLOW_IDS },
  units: [
    // ---- 第一行：预处理 + 生化 + 二沉池 ----
    { id: 'inlet', kind: 'inlet', name: '厂外进水', tag: 'IN', left: 30, top: 120 },
    { id: 'pump', kind: 'pump', name: '进水泵', tag: 'P-101', left: 130, top: 128 },
    { id: 'screen', kind: 'barScreen', name: '细格栅', tag: 'GR-101', left: 240, top: 120 },
    { id: 'grit', kind: 'gritChamber', name: '曝气沉砂池', tag: 'GC-101', left: 400, top: 120 },
    { id: 'primary', kind: 'primaryClarifier', name: '初沉池', tag: 'PC-101', left: 600, top: 120 },
    { id: 'ana', kind: 'anaerobicTank', name: '厌氧池', tag: 'AT-101', left: 790, top: 120 },
    { id: 'anx', kind: 'anoxicTank', name: '缺氧池', tag: 'AX-101', left: 950, top: 120 },
    { id: 'aer', kind: 'aerobicTank', name: '好氧池', tag: 'AE-101', left: 1130, top: 120 },
    { id: 'sec', kind: 'secondaryClarifier', name: '二沉池', tag: 'SC-101', left: 1340, top: 120 },
    // ---- 第二行：深度处理 + 出水 ----
    { id: 'dosing', kind: 'dosingUnit', name: '加药装置', tag: 'DU-101', left: 210, top: 400 },
    { id: 'coag', kind: 'coagulationTank', name: '混凝沉淀池', tag: 'CO-101', left: 400, top: 400 },
    { id: 'filter', kind: 'filterBed', name: '滤布滤池', tag: 'FL-101', left: 620, top: 400 },
    { id: 'disinfect', kind: 'disinfectionTank', name: '消毒接触池', tag: 'DT-101', left: 820, top: 400 },
    { id: 'analyzer', kind: 'analyzer', name: '在线水质监测', tag: 'AIT-101', left: 1010, top: 400 },
    { id: 'meter', kind: 'flowMeter', name: '出水计量', tag: 'FIT-101', left: 1110, top: 400 },
    { id: 'outletValve', kind: 'valve', name: '出水阀', tag: 'V-101', left: 1210, top: 400 },
    { id: 'outlet', kind: 'outlet', name: '排放口', tag: 'OUT', left: 1320, top: 400 },
    // ---- 第三行：污泥线 ----
    { id: 'returnPump', kind: 'submersiblePump', name: '回流污泥泵', tag: 'P-SB-101', left: 1060, top: 292 },
    { id: 'thickener', kind: 'sludgeThickener', name: '污泥浓缩池', tag: 'ST-101', left: 440, top: 660 },
    { id: 'dewater', kind: 'dewateringMachine', name: '污泥脱水机', tag: 'DW-101', left: 660, top: 660 },
    { id: 'screwPump', kind: 'screwPump', name: '污泥输送螺杆泵', tag: 'P-SC-101', left: 762, top: 692 },
    { id: 'sludgeSilo', kind: 'sludgeSilo', name: '污泥料仓', tag: 'SIL-101', left: 880, top: 652 },
    { id: 'sludgeOut', kind: 'sludgeOut', name: '污泥外运', tag: 'SO-101', left: 1020, top: 672 },
    { id: 'deodorizer', kind: 'deodorizer', name: '除臭装置', tag: 'OD-101', left: 430, top: 806 },
    // ---- 串联元件与仪表（自控阀门 / 在线仪表 / 变频器） ----
    { id: 'checkValve', kind: 'checkValve', name: '出水止回阀', tag: 'CV-101', left: 185, top: 128 },
    { id: 'recycleValve', kind: 'motorValve', name: '内回流调节阀', tag: 'MOV-102', left: 1030, top: 36 },
    { id: 'accidentValve', kind: 'motorValve', name: '事故水回流阀', tag: 'MOV-101', left: 1150, top: 520 },
    { id: 'levelGauge', kind: 'levelGauge', name: '事故池液位计', tag: 'LT-101', left: 1082, top: 476 },
    { id: 'pressureGauge', kind: 'pressureGauge', name: '供气干管压力表', tag: 'PT-101', left: 1070, top: -70 },
    { id: 'vfd', kind: 'vfd', name: '鼓风机变频器', tag: 'VFD-101', left: 1204, top: -62 },
    // ---- 事故水支路（出水超标时切入，再回流到生化工段） ----
    { id: 'accidentTank', kind: 'storageTank', name: '事故池', tag: 'EQ-101', left: 970, top: 520 },
    { id: 'accidentPump', kind: 'submersiblePump', name: '事故水回流泵', tag: 'P-SB-102', left: 838, top: 528 },
    // ---- 辅助设备与超越管阀门 ----
    { id: 'blower', kind: 'blower', name: '鼓风机', tag: 'B-201', left: 1130, top: -60 },
    { id: 'bypassValve', kind: 'valve', name: '初沉池超越阀', tag: 'V-102', left: 700, top: 265 },
  ],
  pipes: [
    // ---- 辅助设备与超越管阀门 ----
    { id: 'pipe-inlet-pump', sourceId: 'inlet', targetId: 'pump', medium: 'sewage', dn: 'DN800' },
    { id: 'pipe-pump-check', sourceId: 'pump', targetId: 'checkValve', medium: 'sewage', dn: 'DN800' },
    { id: 'pipe-check-screen', sourceId: 'checkValve', targetId: 'screen', medium: 'sewage', dn: 'DN800' },
    { id: 'pipe-screen-grit', sourceId: 'screen', targetId: 'grit', medium: 'sewage', dn: 'DN800' },
    { id: 'pipe-grit-primary', sourceId: 'grit', targetId: 'primary', medium: 'sewage', dn: 'DN700' },
    { id: 'pipe-primary-ana', sourceId: 'primary', targetId: 'ana', medium: 'sewage', dn: 'DN600' },
    { id: 'pipe-ana-anx', sourceId: 'ana', targetId: 'anx', medium: 'sewage', dn: 'DN600' },
    { id: 'pipe-anx-aer', sourceId: 'anx', targetId: 'aer', medium: 'sewage', dn: 'DN600' },
    { id: 'pipe-aer-sec', sourceId: 'aer', targetId: 'sec', medium: 'sewage', dn: 'DN600' },
    { id: 'pipe-sec-coag', sourceId: 'sec', targetId: 'coag', medium: 'effluent', dn: 'DN500', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-coag-filter', sourceId: 'coag', targetId: 'filter', medium: 'effluent', dn: 'DN500' },
    { id: 'pipe-filter-disinfect', sourceId: 'filter', targetId: 'disinfect', medium: 'effluent', dn: 'DN500' },
    { id: 'pipe-disinfect-analyzer', sourceId: 'disinfect', targetId: 'analyzer', medium: 'effluent', dn: 'DN500' },
    { id: 'pipe-analyzer-meter', sourceId: 'analyzer', targetId: 'meter', medium: 'effluent', dn: 'DN500' },
    { id: 'pipe-meter-valve', sourceId: 'meter', targetId: 'outletValve', medium: 'effluent', dn: 'DN500' },
    { id: 'pipe-valve-outlet', sourceId: 'outletValve', targetId: 'outlet', medium: 'effluent', dn: 'DN500' },
    { id: 'pipe-disinfect-accident', sourceId: 'disinfect', targetId: 'accidentValve', medium: 'effluent', dn: 'DN400' },
    { id: 'pipe-accident-tank', sourceId: 'accidentValve', targetId: 'accidentTank', medium: 'effluent', dn: 'DN400' },
    { id: 'pipe-tank-accidentPump', sourceId: 'accidentTank', targetId: 'accidentPump', medium: 'returnSludge', dn: 'DN400' },
    { id: 'pipe-accidentPump-ana', sourceId: 'accidentPump', targetId: 'ana', medium: 'returnSludge', dn: 'DN400' },
    { id: 'pipe-aer-recycleValve', sourceId: 'aer', targetId: 'recycleValve', medium: 'recycle', dn: 'DN300', sourcePort: 'T', targetPort: 'B' },
    { id: 'pipe-recycleValve-anx', sourceId: 'recycleValve', targetId: 'anx', medium: 'recycle', dn: 'DN300', sourcePort: 'T', targetPort: 'T' },
    { id: 'pipe-sec-returnPump', sourceId: 'sec', targetId: 'returnPump', medium: 'returnSludge', dn: 'DN200', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-returnPump-ana', sourceId: 'returnPump', targetId: 'ana', medium: 'returnSludge', dn: 'DN200', sourcePort: 'L', targetPort: 'B' },
    { id: 'pipe-sec-thickener', sourceId: 'sec', targetId: 'thickener', medium: 'sludge', dn: 'DN200', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-thickener-dewater', sourceId: 'thickener', targetId: 'dewater', medium: 'sludge', dn: 'DN200' },
    { id: 'pipe-dewater-screw', sourceId: 'dewater', targetId: 'screwPump', medium: 'sludge', dn: 'DN150' },
    { id: 'pipe-screw-silo', sourceId: 'screwPump', targetId: 'sludgeSilo', medium: 'sludge', dn: 'DN150' },
    { id: 'pipe-silo-out', sourceId: 'sludgeSilo', targetId: 'sludgeOut', medium: 'sludge', dn: 'DN150' },
    { id: 'pipe-dewater-deodor', sourceId: 'dewater', targetId: 'deodorizer', medium: 'air', dn: 'DN300' },
    { id: 'pipe-tank-level', sourceId: 'accidentTank', targetId: 'levelGauge', medium: 'signal', dn: '' },
    { id: 'pipe-blower-pressure', sourceId: 'blower', targetId: 'pressureGauge', medium: 'signal', dn: '' },
    { id: 'pipe-vfd-blower', sourceId: 'vfd', targetId: 'blower', medium: 'power', dn: '' },
    { id: 'pipe-blower-aer', sourceId: 'blower', targetId: 'aer', medium: 'air', dn: 'DN100', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-dosing-coag', sourceId: 'dosing', targetId: 'coag', medium: 'chemical', dn: 'DN25' },
    { id: 'pipe-grit-bypass', sourceId: 'grit', targetId: 'bypassValve', medium: 'sewage', dn: 'DN600', sourcePort: 'R', targetPort: 'T' },
    { id: 'pipe-bypass-ana', sourceId: 'bypassValve', targetId: 'ana', medium: 'sewage', dn: 'DN600', sourcePort: 'T', targetPort: 'B' },
  ],
};
