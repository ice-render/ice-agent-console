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
 * ## 坐标：**横向排开的三条线 + 两条支路**，间距按"符号尺寸 + 标签"留够
 *
 * 这里原来是从原案例照搬的坐标，密到不好看（相邻池子只隔 40px，位号标签会撞在一起）。
 * 改过一版是因为**绘图区现在是无限画布**：世界坐标里没有"屏幕边界"这回事，
 * 铺得开一点只有一个代价 —— 初始视野的适配倍率会变小；而那个代价正好被
 * "讲到哪里放大到哪里"抵消掉（见 `server/agents/scenarios.ts` 的第一个例子）。
 *
 * 排布规律（改动时照着来，别凭感觉挪）：
 *
 * | 带 | y | 放什么 |
 * |---|---|---|
 * | 空气 / 动力 / 仪表 | -320 | 鼓风机、变频器、压力表 |
 * | 内回流 | -150 | 内回流调节阀（它在好氧池与缺氧池之间，所以放在那两格的**上方空隙**） |
 * | **水线主线** | 100 | 进水 → 预处理 → 生化 → 二沉（10 个单元，一路往右） |
 * | 回流 / 超越 | 340 | 回流污泥泵、初沉池超越阀 |
 * | **深度处理线** | 560 | 加药 → 混凝 → 滤池 → 消毒 → 监测 → 计量 → 排放 |
 * | 事故水支路 | 900 | 事故水回流阀 → 事故池 → 回流泵（再回厌氧池） |
 * | **污泥线** | 1180 | 浓缩 → 脱水 → 输送 → 料仓 → 外运 |
 * | 除臭 | 1400 | 除臭装置 |
 *
 * 横向间距的底线是**符号宽度 + 100**（两条线之间）。为什么不更紧：符号的位号在上、
 * 名称在下，标签宽度往往超过符号本身（"污泥输送螺杆泵"六个字），挨太近就糊成一片。
 *
 * ## 管线端口：**这次几乎全写了**
 *
 * 不写端口时的兜底在 `src/domain/diagram/compile.ts`，是 `R → L`（从左往右）而不是
 * 引擎默认的 `B → T`。旧版 37 段里有 28 段靠这个兜底，因为原坐标下"从左往右"恰好是对的。
 *
 * 铺开之后**不再恰好**了：很多管线要上下走（二沉池出来往左下、事故池往下），
 * 继续靠 R→L 兜底会画出一堆横穿图纸的长线。所以这一段改成**逐条写明**，
 * 只在"确实是左到右"的段上省略。改坐标时**端口要跟着改** —— 这一条最容易漏。
 *
 * ## 数据正确性怎么保证
 *
 * - 结构：`tests/diagram-dsl.test.ts`（白名单 / 引用完整性 / 端口兜底）
 * - 规模：`e2e/diagram.spec.ts` 断言 34 / 37
 * - **工艺语义**：`DiagramLayer.issues()` 走引擎的 `validateWater()`，断言零问题。
 *   同一条断言在 `ice-smart-water` 里也是零问题 —— 两边一致才说明搬的过程中没改语义。
 *   改动坐标**不影响**这一层（校验看的是拓扑，不是几何），所以它是重构时的安全网。
 *
 * ## 为什么放在 `shared/` 而不是 `server/agents/`
 *
 * 因为**开页就要画它**：绘图区在 boot 时装载工艺图，而 boot 跑在浏览器里。
 * `shared/` 是唯一被两套 tsconfig（前端 `tsconfig.json` + 服务端 `tsconfig.server.json`）
 * 同时加载的目录，所以数据放这里 —— 服务端写计划、前端画图，一份来源。
 */
import type { WaterProcessDslDocument } from './diagram';

/**
 * 主流程链（进水 → 生化 → 二沉 → 深度处理 → 排放）。
 *
 * 用来给初始视野一个焦点：图的世界宽度约 1900，而可视区只有 ~1050，
 * 整图适配会把位号文字压到 6px；所以要明确"先看哪儿"。
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
    // ================= 水线主线（y = 100，一路往右） =================
    // 间距 100~130，最紧的一处是 pump→checkValve（这两个是 inline 小件，本身只有 32~44 宽）
    { id: 'inlet', kind: 'inlet', name: '厂外进水', tag: 'IN', left: 60, top: 100 },
    { id: 'pump', kind: 'pump', name: '进水泵', tag: 'P-101', left: 240, top: 104 },
    { id: 'checkValve', kind: 'checkValve', name: '出水止回阀', tag: 'CV-101', left: 350, top: 110 },
    { id: 'screen', kind: 'barScreen', name: '细格栅', tag: 'GR-101', left: 460, top: 100 },
    { id: 'grit', kind: 'gritChamber', name: '曝气沉砂池', tag: 'GC-101', left: 650, top: 100 },
    { id: 'primary', kind: 'primaryClarifier', name: '初沉池', tag: 'PC-101', left: 880, top: 100 },
    { id: 'ana', kind: 'anaerobicTank', name: '厌氧池', tag: 'AT-101', left: 1120, top: 100 },
    { id: 'anx', kind: 'anoxicTank', name: '缺氧池', tag: 'AX-101', left: 1330, top: 100 },
    { id: 'aer', kind: 'aerobicTank', name: '好氧池', tag: 'AE-101', left: 1560, top: 100 },
    { id: 'sec', kind: 'secondaryClarifier', name: '二沉池', tag: 'SC-101', left: 1820, top: 100 },

    // ================= 深度处理线（y = 560，再来一遍左到右） =================
    { id: 'dosing', kind: 'dosingUnit', name: '加药装置', tag: 'DU-101', left: 250, top: 560 },
    { id: 'coag', kind: 'coagulationTank', name: '混凝沉淀池', tag: 'CO-101', left: 520, top: 560 },
    { id: 'filter', kind: 'filterBed', name: '滤布滤池', tag: 'FL-101', left: 800, top: 560 },
    { id: 'disinfect', kind: 'disinfectionTank', name: '消毒接触池', tag: 'DT-101', left: 1080, top: 560 },
    { id: 'analyzer', kind: 'analyzer', name: '在线水质监测', tag: 'AIT-101', left: 1380, top: 570 },
    { id: 'meter', kind: 'flowMeter', name: '出水计量', tag: 'FIT-101', left: 1530, top: 570 },
    { id: 'outletValve', kind: 'valve', name: '出水阀', tag: 'V-101', left: 1660, top: 572 },
    { id: 'outlet', kind: 'outlet', name: '排放口', tag: 'OUT', left: 1800, top: 560 },

    // ================= 空气 / 动力 / 仪表（y = -320，悬在最上面） =================
    // 三个都排在好氧池上方：鼓风机 → 好氧池是主空气管，压力表与变频器都挂在这条线上
    { id: 'pressureGauge', kind: 'pressureGauge', name: '供气干管压力表', tag: 'PT-101', left: 1500, top: -320 },
    { id: 'blower', kind: 'blower', name: '鼓风机', tag: 'B-201', left: 1620, top: -320 },
    { id: 'vfd', kind: 'vfd', name: '鼓风机变频器', tag: 'VFD-101', left: 1790, top: -320 },

    // ================= 内回流（y = -150，卡在厌氧 / 缺氧 / 好氧三格的上方） =================
    { id: 'recycleValve', kind: 'motorValve', name: '内回流调节阀', tag: 'MOV-102', left: 1490, top: -150 },

    // ================= 回流 / 超越（y = 340，在水线与深度处理线之间） =================
    // 回流污泥泵放在厌氧池正下方：回流污泥的终点就是厌氧池，垂直进去最干净
    { id: 'returnPump', kind: 'submersiblePump', name: '回流污泥泵', tag: 'P-SB-101', left: 1150, top: 340 },
    // 超越阀放在沉砂池正下方：初沉池超越管的起点是沉砂池
    { id: 'bypassValve', kind: 'valve', name: '初沉池超越阀', tag: 'V-102', left: 830, top: 350 },

    // ================= 事故水支路（y = 900，压在消毒池下方） =================
    // 出水超标时从这里切进去：消毒池 → 事故水回流阀 → 事故池 → 回流泵 → 厌氧池
    { id: 'accidentValve', kind: 'motorValve', name: '事故水回流阀', tag: 'MOV-101', left: 1150, top: 900 },
    { id: 'accidentTank', kind: 'storageTank', name: '事故池', tag: 'EQ-101', left: 1300, top: 890 },
    { id: 'accidentPump', kind: 'submersiblePump', name: '事故水回流泵', tag: 'P-SB-102', left: 1520, top: 905 },
    { id: 'levelGauge', kind: 'levelGauge', name: '事故池液位计', tag: 'LT-101', left: 1300, top: 1010 },

    // ================= 污泥线（y = 1180，最下面那条） =================
    { id: 'thickener', kind: 'sludgeThickener', name: '污泥浓缩池', tag: 'ST-101', left: 660, top: 1180 },
    { id: 'dewater', kind: 'dewateringMachine', name: '污泥脱水机', tag: 'DW-101', left: 940, top: 1180 },
    { id: 'screwPump', kind: 'screwPump', name: '污泥输送螺杆泵', tag: 'P-SC-101', left: 1170, top: 1210 },
    { id: 'sludgeSilo', kind: 'sludgeSilo', name: '污泥料仓', tag: 'SIL-101', left: 1350, top: 1170 },
    { id: 'sludgeOut', kind: 'sludgeOut', name: '污泥外运', tag: 'SO-101', left: 1560, top: 1180 },

    // ================= 除臭（y = 1400，挂在污泥线下方） =================
    { id: 'deodorizer', kind: 'deodorizer', name: '除臭装置', tag: 'OD-101', left: 850, top: 1400 },
  ],
  pipes: [
    // ---- 水线主线：一路左到右，所以这一段**不写端口**（走 R→L 兜底） ----
    { id: 'pipe-inlet-pump', sourceId: 'inlet', targetId: 'pump', medium: 'sewage', dn: 'DN800' },
    { id: 'pipe-pump-check', sourceId: 'pump', targetId: 'checkValve', medium: 'sewage', dn: 'DN800' },
    { id: 'pipe-check-screen', sourceId: 'checkValve', targetId: 'screen', medium: 'sewage', dn: 'DN800' },
    { id: 'pipe-screen-grit', sourceId: 'screen', targetId: 'grit', medium: 'sewage', dn: 'DN800' },
    { id: 'pipe-grit-primary', sourceId: 'grit', targetId: 'primary', medium: 'sewage', dn: 'DN700' },
    { id: 'pipe-primary-ana', sourceId: 'primary', targetId: 'ana', medium: 'sewage', dn: 'DN600' },
    { id: 'pipe-ana-anx', sourceId: 'ana', targetId: 'anx', medium: 'sewage', dn: 'DN600' },
    { id: 'pipe-anx-aer', sourceId: 'anx', targetId: 'aer', medium: 'sewage', dn: 'DN600' },
    { id: 'pipe-aer-sec', sourceId: 'aer', targetId: 'sec', medium: 'sewage', dn: 'DN600' },

    // ---- 二沉池出来的三路（出水 / 回流污泥 / 剩余污泥）都要**往下**走，必须写端口 ----
    // 三路都从二沉池底部出，于是它们在池子下面分开——这正是图纸上"泥水分流"的那一笔
    { id: 'pipe-sec-coag', sourceId: 'sec', targetId: 'coag', medium: 'effluent', dn: 'DN500', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-sec-returnPump', sourceId: 'sec', targetId: 'returnPump', medium: 'returnSludge', dn: 'DN200', sourcePort: 'B', targetPort: 'R' },
    { id: 'pipe-sec-thickener', sourceId: 'sec', targetId: 'thickener', medium: 'sludge', dn: 'DN200', sourcePort: 'B', targetPort: 'R' },

    // ---- 深度处理线：又是左到右，不写端口 ----
    { id: 'pipe-coag-filter', sourceId: 'coag', targetId: 'filter', medium: 'effluent', dn: 'DN500' },
    { id: 'pipe-filter-disinfect', sourceId: 'filter', targetId: 'disinfect', medium: 'effluent', dn: 'DN500' },
    { id: 'pipe-disinfect-analyzer', sourceId: 'disinfect', targetId: 'analyzer', medium: 'effluent', dn: 'DN500' },
    { id: 'pipe-analyzer-meter', sourceId: 'analyzer', targetId: 'meter', medium: 'effluent', dn: 'DN500' },
    { id: 'pipe-meter-valve', sourceId: 'meter', targetId: 'outletValve', medium: 'effluent', dn: 'DN500' },
    { id: 'pipe-valve-outlet', sourceId: 'outletValve', targetId: 'outlet', medium: 'effluent', dn: 'DN500' },

    // ---- 事故水支路：从消毒池**往下**切出去，再**往上**回到厌氧池 ----
    { id: 'pipe-disinfect-accident', sourceId: 'disinfect', targetId: 'accidentValve', medium: 'effluent', dn: 'DN400', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-accident-tank', sourceId: 'accidentValve', targetId: 'accidentTank', medium: 'effluent', dn: 'DN400' },
    { id: 'pipe-tank-level', sourceId: 'accidentTank', targetId: 'levelGauge', medium: 'signal', dn: '', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-tank-accidentPump', sourceId: 'accidentTank', targetId: 'accidentPump', medium: 'returnSludge', dn: 'DN400' },
    // 回流管**从泵顶出、从厌氧池底进** —— 这样它是一条干净的"上去再进去"，
    // 而不是绕到图纸最右边再横穿整张图（默认路由在两端都在下方时会那样走）。
    { id: 'pipe-accidentPump-ana', sourceId: 'accidentPump', targetId: 'ana', medium: 'returnSludge', dn: 'DN400', sourcePort: 'T', targetPort: 'B' },

    // ---- 内回流（混合液回流）：好氧池 → 调节阀 → 缺氧池，走的是三个池子的**上方** ----
    { id: 'pipe-aer-recycleValve', sourceId: 'aer', targetId: 'recycleValve', medium: 'recycle', dn: 'DN300', sourcePort: 'T', targetPort: 'B' },
    { id: 'pipe-recycleValve-anx', sourceId: 'recycleValve', targetId: 'anx', medium: 'recycle', dn: 'DN300', sourcePort: 'L', targetPort: 'T' },

    // ---- 回流污泥：二沉池 → 回流泵 → 厌氧池（泵在厌氧池正下方，所以是一路向上） ----
    { id: 'pipe-returnPump-ana', sourceId: 'returnPump', targetId: 'ana', medium: 'returnSludge', dn: 'DN200', sourcePort: 'T', targetPort: 'B' },

    // ---- 污泥线：左到右，不写端口 ----
    { id: 'pipe-thickener-dewater', sourceId: 'thickener', targetId: 'dewater', medium: 'sludge', dn: 'DN200' },
    { id: 'pipe-dewater-screw', sourceId: 'dewater', targetId: 'screwPump', medium: 'sludge', dn: 'DN150' },
    { id: 'pipe-screw-silo', sourceId: 'screwPump', targetId: 'sludgeSilo', medium: 'sludge', dn: 'DN150' },
    { id: 'pipe-silo-out', sourceId: 'sludgeSilo', targetId: 'sludgeOut', medium: 'sludge', dn: 'DN150' },

    // ---- 空气 / 动力 / 仪表：鼓风机那一列在上方，管线基本是横着连过去的 ----
    { id: 'pipe-blower-pressure', sourceId: 'blower', targetId: 'pressureGauge', medium: 'signal', dn: '' },
    { id: 'pipe-vfd-blower', sourceId: 'vfd', targetId: 'blower', medium: 'power', dn: '' },
    // 主空气管：从最上面一路下到好氧池，这是全图最长的一根
    { id: 'pipe-blower-aer', sourceId: 'blower', targetId: 'aer', medium: 'air', dn: 'DN100', sourcePort: 'B', targetPort: 'T' },
    // 除臭的抽风管从脱水机房下来
    { id: 'pipe-dewater-deodor', sourceId: 'dewater', targetId: 'deodorizer', medium: 'air', dn: 'DN300', sourcePort: 'B', targetPort: 'T' },

    // ---- 加药：加药装置在混凝池左边，横着过去 ----
    { id: 'pipe-dosing-coag', sourceId: 'dosing', targetId: 'coag', medium: 'chemical', dn: 'DN25' },

    // ---- 初沉池超越管：沉砂池 → 超越阀 → 厌氧池（绕过初沉池） ----
    { id: 'pipe-grit-bypass', sourceId: 'grit', targetId: 'bypassValve', medium: 'sewage', dn: 'DN600', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-bypass-ana', sourceId: 'bypassValve', targetId: 'ana', medium: 'sewage', dn: 'DN600', sourcePort: 'R', targetPort: 'B' },
  ],
};
