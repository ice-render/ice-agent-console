/**
 * **内置案例：某 10 万 m³/d 市政污水厂的 AAO 工艺流程（含提标改造段）**。
 *
 * 这份数据以 `ice-smart-water` 的 `src/domain/plant-case.ts` 为起点，但**已经扩过两轮**：
 * 原案例是"主流程一条线"的示意图，这里按一个真实厂站的形态铺开 ——
 * **两组并联生化线**（真实厂几乎都是多组并联）、配水井 / 集水井、鼓风机房多台、
 * 加药间多点加药、提标改造的臭氧 + 活性炭 + 膜池、污泥干化、两套除臭、
 * 以及每段都有的在线仪表。
 *
 * 数据规模：**78 个单元 / 100 段管线**，用到 `ice-entity-designer` 的
 * **全部 31 种符号种类与全部 9 种介质**。
 *
 * ## 2026-09-17 补的三组"现实里必有的回路"
 *
 * 之前这张图是"主流程一条线 + 各自独立的辅助带"，缺了三处真实厂站**必须有**的东西 ——
 * 补齐之后图才经得起一句"这不像真图"：
 *
 * | 补什么 | 为什么现实里一定有 | 图上是什么 |
 * |---|---|---|
 * | **中间提升泵**（两台互备，`P-111`/`P-112`） | 二沉池出水高程不够，进深度处理前必须提升一次；原来的图等于"二沉出水自己爬上滤池" | `sec1/sec2 → 提升泵 → coag`，原来的两根直连管线被替换 |
 * | **滤池反冲洗回路**（`P-301`/`MOV-301`） | 滤布滤池每运行若干小时要反洗，反洗水回用 | `filter → 反洗泵 → 反洗阀 → distribution`（回到配水井） |
 * | **污泥线回流水** | 浓缩上清液与脱水滤液都要回前端，否则水量算不平 | `thickener → distribution`、`dewater → distribution` |
 *
 * 另外按真实厂的"一用一备 / 一泵一点"补齐：进水泵 B（`P-102`）、剩余污泥泵 B（`P-SB-302`）、
 * 混合液回流泵 A/B（`P-104`/`P-204`，原来只有回流**阀**没有**泵**）、PAC/PAM 计量泵（`P-401`/`P-402`）。
 *
 * ⚠️ 布局的松紧**没动**：`tests/diagram-layout.test.ts` 有一条"每单元摊到的世界面积 ≥ 300k"，
 * 那是"不要把图摆得太小气"的落点；这一轮只**加内容**，不加密度。
 *
 * ## 判定"真实"的标准不是"看着热闹"，而是**图上可判定的工艺约束**
 *
 * `DiagramLayer.issues()` 走引擎的 `validateWater()`，断言零问题。它的规则是：
 *
 * | 规则 | 本图怎么满足 |
 * |---|---|
 * | 位号唯一 | 位号按"设备类别 + 序号"编（`AT-201` / `AT-202` 是两组厌氧池），不重号 |
 * | 没有孤立符号 | 每个单元都至少接一根管线（含仪表线 / 动力线） |
 * | 管线要标介质与管径 | 信号线与动力线不校验 DN（那不是管道） |
 * | 进水走得到出水，且路径上有在线监测 | 主线串通，`AIT-301` 在最短路径上 |
 * | 剩余污泥有出路 | 浓缩 → 脱水 → 干化 → 料仓 → 外运 整条都在 |
 * | AAO 要有混合液内回流 | 两组各一条 `recycle` 管 |
 *
 * ⚠️ 校验**逐条**看，一条 warning 都不许有 —— e2e 断言的是 `issues` 为空数组，
 * 而 warning（比如"某单元没有任何管线"）也在这个数组里。加单元时最容易忘的是仪表：
 * 它们只接一根信号线，漏了就是孤立符号。
 *
 * ## 坐标：横向分带 + 两组并联，世界尺寸约 4900×2400
 *
 * | 带 | y | 放什么 |
 * |---|---|---|
 * | 供电 / 鼓风 | -430 | 变压器、变频器、鼓风机 A/B/C |
 * | 空气管网 / 内回流 | -240 | 供气干管压力表、两组内回流阀 |
 * | **① 水线主线（第一组生化）** | 60 | 进水 → 预处理 → AAO-1 → 二沉-1 |
 * | ② 第二组生化（并联） | 300 | AAO-2 → 二沉-2（由配水井分出） |
 * | 回流 / 超越 / 剩余污泥 | 560 | 回流泵×2、超越阀、剩余污泥泵 |
 * | **深度处理 + 提标改造段** | 900 | 混凝 → 滤池 → 臭氧 → 活性炭 → 膜池 → 消毒（**在生化段右侧继续往右**） |
 * | 事故水 | 1300 | 事故水阀 → 事故池 → 回流泵 |
 * | **污泥线** | 1580 | 浓缩 → 脱水 → 干化 → 料仓 → 外运 |
 * | 除臭 / 加药间 | 1900 | 两套除臭、PAC/PAM/次钠/碳源四个加药点 |
 *
 * 横向间距的底线是**符号宽度 + 100**；两组并联之间也留了整条带的高度差，
 * 让"哪几格属于第一组、哪几格属于第二组"一眼可辨。
 *
 * ## 管线端口：**全部写明**
 *
 * 不写端口时的兜底在 `src/domain/diagram/compile.ts`，是 `R → L`（从左往右），
 * 而引擎的默认又是 `B → T`。这张图铺得开、有并联、有大量上下走线，
 * **没有一处能靠兜底"恰好"走对** —— 所以 92 段逐条写明。
 * 改坐标时端口要跟着改，这是最容易漏的一步。
 *
 * ## 为什么放在 `shared/` 而不是 `server/agents/`
 *
 * 因为**开页就要画它**：绘图区在 boot 时装载工艺图，而 boot 跑在浏览器里。
 * `shared/` 是唯一被两套 tsconfig（前端 `tsconfig.json` + 服务端 `tsconfig.server.json`）
 * 同时加载的目录，所以数据放这里 —— 服务端写计划、前端画图，一份来源。
 */
import type {
  WaterProcessDslDocument,
  WaterProcessPipe,
  WaterProcessUnit,
} from './diagram';

/**
 * 主流程链（进水 → 第一组生化 → 二沉 → 深度处理 → 提标段 → 排放）。
 *
 * 用来给初始视野一个焦点：图的世界宽约 4900，而可视区只有 ~1050，
 * 整图适配会把位号压到 4px 以下；所以要明确"先看哪儿"。
 *
 * 注意它走的是**第一组**生化线（`ana1/anx1/aer1`）—— 两组是并联的，
 * 主流程链只需要说明其中一条是怎么走的。
 */
export const MAIN_FLOW_IDS = [
  'inlet', 'coarseScreen', 'inletPump', 'checkValve', 'fineScreen', 'grit', 'primary',
  'distribution',
  'ana1', 'anx1', 'aer1', 'sec1',
  // 二沉出水先经**中间提升泵**再进深度处理（真实厂的高程要求）
  'midPumpA',
  // ⚠️ 提标改造段的 ozone / carbon / membrane **不在这里** —— 它们不在基准图里，
  //    是 `UPGRADE_UNITS` 后面补上去的。写进来会被校验器判成"引用了不存在的单元"
  //    （`viewport.focus` 是校验项之一，这一条是实测踩到的）。
  'coag', 'filter', 'disinfect',
  'analyzer', 'meter', 'outletValve', 'outlet',
];

/** 第一组生化线（扩建前的原有线）。 */
const TRAIN_1 = ['ana1', 'anx1', 'aer1', 'sec1'];
/** 第二组生化线（扩建增容时并上来的那一组，A/B 两组并联运行）。 */
const TRAIN_2 = ['ana2', 'anx2', 'aer2', 'sec2'];

// ---------------------------------------------------------------------------
// 提标改造：会被"动态增删"那一条剧本临时加/删的图元
// ---------------------------------------------------------------------------

/**
 * **提标改造新增的单元**（出水标准从一级 A 提到地表水准 IV 类）。
 *
 * 为什么单独导出：`server/agents/scenarios.ts` 的「提标改造」剧本要靠它构造
 * `STATE_DELTA` 的 JSON Patch 载荷（往 `/diagram/units/-` 追加这几条）。
 * 数据在这儿、补丁在那儿拼，**同一份来源** —— 两边各写一份坐标必然会漂。
 *
 * 三个单元是真实的提标工艺顺序：**臭氧氧化 → 活性炭吸附 → 膜过滤**。
 * 它们插在 `filter`（滤布滤池）与 `disinfect`（消毒）之间。
 */
export const UPGRADE_UNITS: WaterProcessUnit[] = [
  { id: 'ozone', kind: 'storageTank', name: '臭氧接触池', tag: 'OT-301', left: 5600, top: 1575 },
  { id: 'carbon', kind: 'filterBed', name: '活性炭滤池', tag: 'AC-301', left: 6055, top: 1575 },
  { id: 'membrane', kind: 'filterBed', name: '膜池（超滤）', tag: 'UF-301', left: 6510, top: 1575 },
];

/**
 * 提标改造新增的管线。
 *
 * ⚠️ 它**改接了主管**：原来 `filter → disinfect` 直连，改造后要绕经三个新单元。
 * 所以补丁是"删一根 + 加四根"，不是单纯地加 —— 这正是"动态增删"要演示的东西：
 * 增与删常常是**成对**的（改接一处管线 = 一删一加）。
 */
export const UPGRADE_PIPES: WaterProcessPipe[] = [
  { id: 'pipe-filter-ozone', sourceId: 'filter', targetId: 'ozone', medium: 'effluent', dn: 'DN500' },
  { id: 'pipe-ozone-carbon', sourceId: 'ozone', targetId: 'carbon', medium: 'effluent', dn: 'DN500' },
  { id: 'pipe-carbon-membrane', sourceId: 'carbon', targetId: 'membrane', medium: 'effluent', dn: 'DN500' },
  { id: 'pipe-membrane-disinfect', sourceId: 'membrane', targetId: 'disinfect', medium: 'effluent', dn: 'DN500' },
];

/**
 * 拆掉初沉池之后**补上**的连通管（沉砂池直进配水井）。
 *
 * 为什么必须有：删 `primary` 会连带删掉 `pipe-grit-primary` 与 `pipe-primary-dist`，
 * 于是"进水走不到出水"，`validateWater()` 会报 `flow-disconnected`。
 * 真实改造里也不可能只拆不接 —— **拆一处、接一处**才是改图的本相，
 * 所以这一根不是"为了让校验通过而补的"，它本来就在工程范围里。
 */
export const UPGRADE_BRIDGE_PIPES: WaterProcessPipe[] = [
  { id: 'pipe-grit-dist', sourceId: 'grit', targetId: 'distribution', medium: 'sewage', dn: 'DN900', sourcePort: 'R', targetPort: 'L' },
];

/** 提标改造要**删掉**的那根直连管线（被上面四条取代）。 */
export const UPGRADE_REMOVED_PIPE_IDS = ['pipe-filter-disinfect'];

/**
 * **拆除初沉池**：AAO 前不设初沉池可以让更多碳源进生化段（真实做法，不是随手删）。
 *
 * ⚠️ 别以为"引擎会级联，所以补丁里不用列管线"。渲染层**确实**会级联
 * （`FlowDesigner.remove` 顺手删掉挂在它身上的管线），但那保证的只是**画面**干净 ——
 * `state` 那份文档是另一条账：JSON Patch 只从 `units` 里拿掉一项，
 * 管线数组会原封不动，于是文档里留下悬空的管线。
 *
 * 所以 `scenarios.ts` 的 `upgradePlan` 用 `pipesTouching()` **显式把它们列全**。
 * 这张图上 `primary` 身上挂着**三根**（`pipe-grit-primary` / `pipe-primary-dist` /
 * `pipe-primary-deodor1`）—— 早先这里写的是"两根"，漏掉了通往除臭装置的那一根；
 * 数字别手抄，以 `pipesTouching()` 现算的为准。
 */
export const UPGRADE_REMOVED_UNIT_IDS = ['primary'];

/**
 * 基础工艺图（提标改造**之前**的那一版）。
 *
 * ⚠️ 标题只描述**本图真有**的东西：`filter` 与 `disinfect` 之间那段空白是给
 * `UPGRADE_UNITS` 预留的，臭氧 / 活性炭 / 超滤是「提标改造」剧本才加进去的。
 * 早先标题把这三个写进去了，画面上却没有 —— 标题与图不符，用户一眼能看出来。
 */
export const WATER_PROCESS_DSL: WaterProcessDslDocument = {
  kind: 'water-process',
  title: 'AAO 两组并联 + 混凝沉淀 + 滤布滤池 + 消毒（10 万 m³/d）',
  /**
   * **开页取景 = 整条主流程**（`MAIN_FLOW_IDS` 的全部单元），裁掉的只有纵向那些辅助带。
   *
   * ⚠️ 这是**确认过的产品决定（2026-09-17）**，不要再"优化"成开页近景：
   * 主流程横向铺满整图（进水最左、排放口最右），所以按它适配出来大约 **0.14 倍** ——
   * 第一眼确实像缩略图、位号也读不出来，但**"开页就看到全流程"是刻意的**：
   * 这一屏回答的是"这座厂长什么样、水从哪来到哪去"，读细节靠**滚轮放大**（0.37 倍左右就能看清
   * 单元名、介质色与 DN 标注），"看全图"另有 `fitAll()`。
   *
   * 之所以写下来：这条曾经被当成缺陷提过一次（"开页看不到完整主流程，而且怎么缩都缩不出来"），
   * 那次的真问题是 `minScale` 把初始倍率**夹住**了（见 `diagram-layer.ts` 里那段注释），
   * 不是"取景太远"。取景本身是设计意图，改它等于换一个产品行为。
   */
  viewport: { focus: MAIN_FLOW_IDS },
  units: [
    // ================= 水线主线：预处理（y = 60，一路往右） =================
    { id: 'inlet', kind: 'inlet', name: '厂外进水', tag: 'IN', left: 105, top: 105 },
    { id: 'coarseScreen', kind: 'barScreen', name: '粗格栅', tag: 'GR-101', left: 420, top: 105 },
    { id: 'inletPump', kind: 'pump', name: '进水泵', tag: 'P-101', left: 755, top: 115 },
    { id: 'inletPumpB', kind: 'pump', name: '进水泵 B（备用）', tag: 'P-102', left: 755, top: 285 },
    { id: 'checkValve', kind: 'checkValve', name: '出水止回阀', tag: 'CV-101', left: 945, top: 120 },
    { id: 'fineScreen', kind: 'barScreen', name: '细格栅', tag: 'GR-102', left: 1140, top: 105 },
    { id: 'grit', kind: 'gritChamber', name: '曝气沉砂池', tag: 'GC-101', left: 1470, top: 105 },
    // ⚠️ 初沉池在这一版里**会被拆掉** —— 见 UPGRADE_REMOVED_UNIT_IDS。
    //    提标改造剧本删它（AAO 前不设初沉池可以让更多碳源进生化段，是真实做法）。
    { id: 'primary', kind: 'primaryClarifier', name: '初沉池', tag: 'PC-101', left: 1870, top: 105 },
    // 配水井：两组生化线的分水点。真实厂里必须有，否则两组配水不均
    { id: 'distribution', kind: 'storageTank', name: '配水井', tag: 'DW-101', left: 2255, top: 105 },

    // ================= ① 第一组生化线（y = 60） =================
    { id: 'ana1', kind: 'anaerobicTank', name: '厌氧池 A', tag: 'AT-101', left: 2680, top: 105 },
    { id: 'anx1', kind: 'anoxicTank', name: '缺氧池 A', tag: 'AX-101', left: 3045, top: 105 },
    { id: 'aer1', kind: 'aerobicTank', name: '好氧池 A', tag: 'AE-101', left: 3445, top: 105 },
    { id: 'sec1', kind: 'secondaryClarifier', name: '二沉池 A', tag: 'SC-101', left: 3940, top: 105 },

    // ================= ② 第二组生化线（y = 300，与第一组并联） =================
    { id: 'ana2', kind: 'anaerobicTank', name: '厌氧池 B', tag: 'AT-201', left: 2680, top: 525 },
    { id: 'anx2', kind: 'anoxicTank', name: '缺氧池 B', tag: 'AX-201', left: 3045, top: 525 },
    { id: 'aer2', kind: 'aerobicTank', name: '好氧池 B', tag: 'AE-201', left: 3445, top: 525 },
    { id: 'sec2', kind: 'secondaryClarifier', name: '二沉池 B', tag: 'SC-201', left: 3940, top: 525 },

    // ================= 回流 / 剩余污泥 / 超越（y = 560） =================
    // 两组各一台回流泵（各自回到自己那组厌氧池）+ 一台共用的剩余污泥泵
    { id: 'returnPump1', kind: 'submersiblePump', name: '回流污泥泵 A', tag: 'P-SB-101', left: 2730, top: 980 },
    { id: 'wastePumpB', kind: 'submersiblePump', name: '剩余污泥泵 B（备用）', tag: 'P-SB-302', left: 4235, top: 1150 },
    { id: 'returnPump2', kind: 'submersiblePump', name: '回流污泥泵 B', tag: 'P-SB-201', left: 3130, top: 980 },
    { id: 'wastePump', kind: 'submersiblePump', name: '剩余污泥泵', tag: 'P-SB-301', left: 4235, top: 980 },
    { id: 'bypassValve', kind: 'valve', name: '初沉池超越阀', tag: 'V-102', left: 1680, top: 995 },

    // ================= 深度处理 + 提标改造段（y = 900） =================
    // ⚠️ 位置在生化段**右侧**，图纸上是一条继续往右的线 —— 深度处理在二沉池之后，
    //    摆到左边会让出水线倒着走（第一版就是这么摆的，看起来很别扭）。
    /**
     * **中间提升泵**（两台互为备用）—— 真实厂站里**必有**：二沉池出水高程不够，
     * 进深度处理（混凝 / 滤池 / 臭氧 / 膜）之前必须先提升一次。
     * 早先的图把它省了，等于"二沉出水自己爬上滤池"，工艺上是错的。
     */
    { id: 'midPumpA', kind: 'pump', name: '中间提升泵 A', tag: 'P-111', left: 4180, top: 1575 },
    { id: 'midPumpB', kind: 'pump', name: '中间提升泵 B（备用）', tag: 'P-112', left: 4180, top: 1755 },
    { id: 'coag', kind: 'coagulationTank', name: '混凝沉淀池', tag: 'CO-101', left: 4550, top: 1575 },
    { id: 'filter', kind: 'filterBed', name: '滤布滤池', tag: 'FL-101', left: 5075, top: 1575 },
    /**
     * **滤池反冲洗**：滤布滤池每运行若干小时要反洗一次，反洗水回**配水井**回用 ——
     * 真图上的典型回路，也解释了"配水井为什么不是只接初沉出水"。
     */
    { id: 'backwashPump', kind: 'pump', name: '反冲洗泵', tag: 'P-301', left: 5075, top: 1770 },
    { id: 'backwashValve', kind: 'motorValve', name: '反洗进水阀', tag: 'MOV-301', left: 5275, top: 1770 },
    // ⚠️ 提标改造把 ozone / carbon / membrane 插在这一格（见 UPGRADE_UNITS），
    //    并把 filter → disinfect 的直连管线换成绕经它们的四条。
    //    这段空白是**刻意留的**：改造要加的东西得先有位子。
    // ↓ ozone(3200) ↓ carbon(3460) ↓ membrane(3720)
    { id: 'disinfect', kind: 'disinfectionTank', name: '消毒接触池', tag: 'DT-101', left: 6965, top: 1575 },
    { id: 'analyzer', kind: 'analyzer', name: '在线水质监测', tag: 'AIT-101', left: 7490, top: 1595 },
    { id: 'meter', kind: 'flowMeter', name: '出水计量', tag: 'FIT-101', left: 7755, top: 1595 },
    { id: 'outletValve', kind: 'valve', name: '出水阀', tag: 'V-101', left: 7980, top: 1595 },
    { id: 'outlet', kind: 'outlet', name: '排放口', tag: 'OUT', left: 8225, top: 1575 },

    // 出水四项在线监测：排污许可要求 COD / 氨氮 / 总磷 / 总氮 全部联网上传。
    // 四台并排挂在出水管下侧，真实图纸上就是这一簇。
    { id: 'codAnalyzer', kind: 'analyzer', name: '出水 COD 在线', tag: 'AIT-106', left: 7700, top: 1805 },
    { id: 'nh3Analyzer', kind: 'analyzer', name: '出水氨氮在线', tag: 'AIT-107', left: 7980, top: 1805 },
    { id: 'tpAnalyzer', kind: 'analyzer', name: '出水总磷在线', tag: 'AIT-108', left: 8260, top: 1805 },
    { id: 'tnAnalyzer', kind: 'analyzer', name: '出水总氮在线', tag: 'AIT-109', left: 8540, top: 1805 },
    { id: 'turbidityGauge', kind: 'analyzer', name: '出水浊度仪', tag: 'AIT-104', left: 7210, top: 1805 },

    // ================= 再生水回用（y = 700，从出水计量后分出去） =================
    { id: 'reclaimedPump', kind: 'pump', name: '再生水回用泵', tag: 'P-201', left: 7490, top: 1225 },
    { id: 'outletFlowMeterB', kind: 'flowMeter', name: '再生水计量', tag: 'FIT-105', left: 7750, top: 1225 },

    // ================= 事故水支路（y = 1300） =================
    { id: 'accidentValve', kind: 'motorValve', name: '事故水回流阀', tag: 'MOV-101', left: 7140, top: 2275 },
    { id: 'accidentTank', kind: 'storageTank', name: '事故池', tag: 'EQ-101', left: 7440, top: 2255 },
    { id: 'accidentPump', kind: 'submersiblePump', name: '事故水回流泵', tag: 'P-SB-401', left: 7820, top: 2280 },
    { id: 'levelGauge', kind: 'levelGauge', name: '事故池液位计', tag: 'LT-101', left: 7440, top: 2470 },
    { id: 'accidentFlowMeter', kind: 'flowMeter', name: '事故水流量计', tag: 'FIT-104', left: 8050, top: 2255 },

    // ================= 污泥线（y = 1580） =================
    { id: 'thickener', kind: 'sludgeThickener', name: '污泥浓缩池', tag: 'ST-101', left: 2540, top: 2765 },
    { id: 'dewater', kind: 'dewateringMachine', name: '污泥脱水机', tag: 'DW-201', left: 3030, top: 2765 },
    { id: 'dryer', kind: 'dewateringMachine', name: '污泥干化机', tag: 'DR-101', left: 3480, top: 2765 },
    { id: 'screwPump', kind: 'screwPump', name: '污泥输送螺杆泵', tag: 'P-SC-101', left: 3920, top: 2820 },
    { id: 'sludgeSilo', kind: 'sludgeSilo', name: '污泥料仓', tag: 'SIL-101', left: 4235, top: 2745 },
    { id: 'sludgeOut', kind: 'sludgeOut', name: '污泥外运', tag: 'SO-101', left: 4605, top: 2765 },
    { id: 'sludgeFlowMeter', kind: 'flowMeter', name: '污泥流量计', tag: 'FIT-103', left: 2800, top: 2940 },

    // ================= 加药间（四个加药点，真实厂就是这四个系统） =================
    { id: 'pacDosing', kind: 'dosingUnit', name: 'PAC 加药装置', tag: 'DU-101', left: 4550, top: 2190 },
    { id: 'pacPump', kind: 'pump', name: 'PAC 计量泵', tag: 'P-401', left: 4760, top: 2190 },
    { id: 'pamDosing', kind: 'dosingUnit', name: 'PAM 加药装置', tag: 'DU-102', left: 3030, top: 3325 },
    { id: 'pamPump', kind: 'pump', name: 'PAM 计量泵', tag: 'P-402', left: 3420, top: 3325 },
    { id: 'naoclDosing', kind: 'dosingUnit', name: '次氯酸钠加药', tag: 'DU-103', left: 6965, top: 1855 },
    { id: 'carbonDosing', kind: 'dosingUnit', name: '碳源投加装置', tag: 'DU-104', left: 2545, top: 315 },

    // ================= 除臭（两套：预处理区 / 污泥区） =================
    { id: 'deodor1', kind: 'deodorizer', name: '除臭装置（预处理）', tag: 'OD-101', left: 1470, top: 2100 },
    { id: 'deodorFan1', kind: 'blower', name: '除臭风机 1#', tag: 'B-201', left: 1190, top: 2255 },
    { id: 'deodor2', kind: 'deodorizer', name: '除臭装置（污泥区）', tag: 'OD-201', left: 3480, top: 3115 },
    { id: 'deodorFan2', kind: 'blower', name: '除臭风机 2#', tag: 'B-202', left: 3240, top: 3270 },

    // ================= 鼓风机房 / 供配电（y = -430 / -300） =================
    { id: 'transformer', kind: 'vfd', name: '变压器', tag: 'TR-101', left: 3240, top: -755 },
    { id: 'vfdA', kind: 'vfd', name: '鼓风机变频器 A', tag: 'VFD-101', left: 3640, top: -755 },
    { id: 'vfdB', kind: 'vfd', name: '鼓风机变频器 B', tag: 'VFD-201', left: 3990, top: -755 },
    { id: 'blowerA', kind: 'blower', name: '鼓风机 A', tag: 'B-101', left: 3590, top: -525 },
    { id: 'blowerB', kind: 'blower', name: '鼓风机 B', tag: 'B-102', left: 3850, top: -525 },
    { id: 'blowerC', kind: 'blower', name: '鼓风机 C（备用）', tag: 'B-103', left: 4115, top: -525 },
    { id: 'airGauge', kind: 'pressureGauge', name: '供气干管压力表', tag: 'PT-101', left: 3325, top: -525 },
    { id: 'airFlowMeter', kind: 'flowMeter', name: '空气流量计', tag: 'FIT-102', left: 3480, top: -700 },

    // ================= 内回流阀（两组各一个，卡在好氧池上方） =================
    { id: 'recycleValve1', kind: 'motorValve', name: '内回流调节阀 A', tag: 'MOV-102', left: 3060, top: -315 },
    { id: 'recyclePumpA', kind: 'pump', name: '混合液回流泵 A', tag: 'P-104', left: 2900, top: -315 },
    { id: 'recycleValve2', kind: 'motorValve', name: '内回流调节阀 B', tag: 'MOV-202', left: 3270, top: 350 },
    { id: 'recyclePumpB', kind: 'pump', name: '混合液回流泵 B', tag: 'P-204', left: 3090, top: 350 },

    // ================= 过程在线仪表（每段一个） =================
    { id: 'phInlet', kind: 'analyzer', name: '进水 pH 计', tag: 'AIT-105', left: 525, top: -105 },
    { id: 'doAer1', kind: 'analyzer', name: '好氧池 A 溶解氧', tag: 'AIT-102', left: 3500, top: -105 },
    { id: 'doAer2', kind: 'analyzer', name: '好氧池 B 溶解氧', tag: 'AIT-202', left: 3500, top: 315 },
    { id: 'mlssGauge', kind: 'analyzer', name: '污泥浓度计', tag: 'AIT-103', left: 4305, top: 315 },
  ],
  pipes: [
    // ---- 预处理：一路左到右 ----
    { id: 'pipe-inlet-coarse', sourceId: 'inlet', targetId: 'coarseScreen', medium: 'sewage', dn: 'DN1000', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-coarse-pump', sourceId: 'coarseScreen', targetId: 'inletPump', medium: 'sewage', dn: 'DN1000', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-coarse-pumpB', sourceId: 'coarseScreen', targetId: 'inletPumpB', medium: 'sewage', dn: 'DN1000', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-pumpB-check', sourceId: 'inletPumpB', targetId: 'checkValve', medium: 'sewage', dn: 'DN1000', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-pump-check', sourceId: 'inletPump', targetId: 'checkValve', medium: 'sewage', dn: 'DN1000', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-check-fine', sourceId: 'checkValve', targetId: 'fineScreen', medium: 'sewage', dn: 'DN1000', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-fine-grit', sourceId: 'fineScreen', targetId: 'grit', medium: 'sewage', dn: 'DN1000', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-grit-primary', sourceId: 'grit', targetId: 'primary', medium: 'sewage', dn: 'DN900', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-primary-dist', sourceId: 'primary', targetId: 'distribution', medium: 'sewage', dn: 'DN900', sourcePort: 'R', targetPort: 'L' },

    // ---- 配水井分水：两组并联的起点。一个 `C` 出两个头，这是配水井的图面表达 ----
    { id: 'pipe-dist-ana1', sourceId: 'distribution', targetId: 'ana1', medium: 'sewage', dn: 'DN700', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-dist-ana2', sourceId: 'distribution', targetId: 'ana2', medium: 'sewage', dn: 'DN700', sourcePort: 'B', targetPort: 'L' },

    // ---- ① 第一组生化线 ----
    { id: 'pipe-ana1-anx1', sourceId: 'ana1', targetId: 'anx1', medium: 'sewage', dn: 'DN700', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-anx1-aer1', sourceId: 'anx1', targetId: 'aer1', medium: 'sewage', dn: 'DN700', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-aer1-sec1', sourceId: 'aer1', targetId: 'sec1', medium: 'sewage', dn: 'DN700', sourcePort: 'R', targetPort: 'L' },
    // 二沉池 A 出来四路：出水（往下）、回流污泥、剩余污泥、混合液浓度监测
    // 二沉出水先到**中间提升泵**（两台互备），再并入深度处理进水管 —— 不经泵直连是工艺错误
    { id: 'pipe-sec1-midpumpA', sourceId: 'sec1', targetId: 'midPumpA', medium: 'effluent', dn: 'DN600', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-midpumpA-coag', sourceId: 'midPumpA', targetId: 'coag', medium: 'effluent', dn: 'DN600', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-sec1-return1', sourceId: 'sec1', targetId: 'returnPump1', medium: 'returnSludge', dn: 'DN250', sourcePort: 'B', targetPort: 'R' },
    { id: 'pipe-return1-ana1', sourceId: 'returnPump1', targetId: 'ana1', medium: 'returnSludge', dn: 'DN250', sourcePort: 'T', targetPort: 'B' },

    // ---- ② 第二组生化线 ----
    { id: 'pipe-ana2-anx2', sourceId: 'ana2', targetId: 'anx2', medium: 'sewage', dn: 'DN700', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-anx2-aer2', sourceId: 'anx2', targetId: 'aer2', medium: 'sewage', dn: 'DN700', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-aer2-sec2', sourceId: 'aer2', targetId: 'sec2', medium: 'sewage', dn: 'DN700', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-sec2-midpumpB', sourceId: 'sec2', targetId: 'midPumpB', medium: 'effluent', dn: 'DN600', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-midpumpB-coag', sourceId: 'midPumpB', targetId: 'coag', medium: 'effluent', dn: 'DN600', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-sec2-return2', sourceId: 'sec2', targetId: 'returnPump2', medium: 'returnSludge', dn: 'DN250', sourcePort: 'B', targetPort: 'R' },
    { id: 'pipe-return2-ana2', sourceId: 'returnPump2', targetId: 'ana2', medium: 'returnSludge', dn: 'DN250', sourcePort: 'T', targetPort: 'B' },

    // ---- 内回流（两组各一条，AAO 的必需项） ----
    { id: 'pipe-aer1-recycle1', sourceId: 'aer1', targetId: 'recycleValve1', medium: 'recycle', dn: 'DN350', sourcePort: 'T', targetPort: 'B' },
    { id: 'pipe-aer1-recyclePumpA', sourceId: 'aer1', targetId: 'recyclePumpA', medium: 'recycle', dn: 'DN350', sourcePort: 'T', targetPort: 'B' },
    { id: 'pipe-recyclePumpA-valve1', sourceId: 'recyclePumpA', targetId: 'recycleValve1', medium: 'recycle', dn: 'DN350', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-recycle1-anx1', sourceId: 'recycleValve1', targetId: 'anx1', medium: 'recycle', dn: 'DN350', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-aer2-recycle2', sourceId: 'aer2', targetId: 'recycleValve2', medium: 'recycle', dn: 'DN350', sourcePort: 'T', targetPort: 'B' },
    { id: 'pipe-aer2-recyclePumpB', sourceId: 'aer2', targetId: 'recyclePumpB', medium: 'recycle', dn: 'DN350', sourcePort: 'T', targetPort: 'B' },
    { id: 'pipe-recyclePumpB-valve2', sourceId: 'recyclePumpB', targetId: 'recycleValve2', medium: 'recycle', dn: 'DN350', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-recycle2-anx2', sourceId: 'recycleValve2', targetId: 'anx2', medium: 'recycle', dn: 'DN350', sourcePort: 'B', targetPort: 'T' },

    // ---- 剩余污泥：两组二沉池都往剩余污泥泵汇 ----
    { id: 'pipe-sec1-waste', sourceId: 'sec1', targetId: 'wastePump', medium: 'sludge', dn: 'DN200', sourcePort: 'R', targetPort: 'T' },
    { id: 'pipe-sec2-waste', sourceId: 'sec2', targetId: 'wastePump', medium: 'sludge', dn: 'DN200', sourcePort: 'R', targetPort: 'B' },
    { id: 'pipe-sec2-wasteB', sourceId: 'sec2', targetId: 'wastePumpB', medium: 'sludge', dn: 'DN200', sourcePort: 'B', targetPort: 'L' },
    { id: 'pipe-wasteB-thickener', sourceId: 'wastePumpB', targetId: 'thickener', medium: 'sludge', dn: 'DN200', sourcePort: 'L', targetPort: 'B' },
    { id: 'pipe-waste-thickener', sourceId: 'wastePump', targetId: 'thickener', medium: 'sludge', dn: 'DN200', sourcePort: 'L', targetPort: 'T' },

    // ---- 深度处理 + 提标改造段 ----
    { id: 'pipe-coag-filter', sourceId: 'coag', targetId: 'filter', medium: 'effluent', dn: 'DN600', sourcePort: 'R', targetPort: 'L' },
    // ⚠️ 这根就是提标改造要**删掉**的那根（见 UPGRADE_REMOVED_PIPE_IDS）：
    //    改了之后要绕经臭氧 → 活性炭 → 膜池。
    { id: 'pipe-filter-disinfect', sourceId: 'filter', targetId: 'disinfect', medium: 'effluent', dn: 'DN500', sourcePort: 'R', targetPort: 'L' },
    // ---- 滤池反冲洗回路：清水侧取水加压反冲 → 反洗水回配水井（真图上的典型回路）----
    { id: 'pipe-filter-backwash', sourceId: 'filter', targetId: 'backwashPump', medium: 'effluent', dn: 'DN300', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-backwash-valve', sourceId: 'backwashPump', targetId: 'backwashValve', medium: 'effluent', dn: 'DN300', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-backwash-dist', sourceId: 'backwashValve', targetId: 'distribution', medium: 'sewage', dn: 'DN300', sourcePort: 'T', targetPort: 'B' },
    { id: 'pipe-disinfect-analyzer', sourceId: 'disinfect', targetId: 'analyzer', medium: 'effluent', dn: 'DN500', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-analyzer-meter', sourceId: 'analyzer', targetId: 'meter', medium: 'effluent', dn: 'DN500', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-meter-valve', sourceId: 'meter', targetId: 'outletValve', medium: 'effluent', dn: 'DN500', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-valve-outlet', sourceId: 'outletValve', targetId: 'outlet', medium: 'effluent', dn: 'DN500', sourcePort: 'R', targetPort: 'L' },

    // ---- 事故水支路 ----
    { id: 'pipe-disinfect-accident', sourceId: 'disinfect', targetId: 'accidentValve', medium: 'effluent', dn: 'DN400', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-accident-tank', sourceId: 'accidentValve', targetId: 'accidentTank', medium: 'effluent', dn: 'DN400', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-tank-level', sourceId: 'accidentTank', targetId: 'levelGauge', medium: 'signal', dn: '', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-tank-accidentPump', sourceId: 'accidentTank', targetId: 'accidentPump', medium: 'returnSludge', dn: 'DN400', sourcePort: 'R', targetPort: 'L' },
    // 事故水打回第一组厌氧池（回流到生化段重新处理，不是排放）
    { id: 'pipe-accidentPump-ana1', sourceId: 'accidentPump', targetId: 'ana1', medium: 'returnSludge', dn: 'DN400', sourcePort: 'T', targetPort: 'R' },
    { id: 'pipe-tank-accidentFlow', sourceId: 'accidentTank', targetId: 'accidentFlowMeter', medium: 'signal', dn: '', sourcePort: 'R', targetPort: 'L' },

    // ---- 污泥线：浓缩 → 脱水 → 干化 → 输送 → 料仓 → 外运 ----
    { id: 'pipe-thickener-dewater', sourceId: 'thickener', targetId: 'dewater', medium: 'sludge', dn: 'DN200', sourcePort: 'R', targetPort: 'L' },
    // ---- 污泥线回流水：浓缩上清液与脱水滤液都回配水井（不画这条，前端水量算不平）----
    { id: 'pipe-thickener-dist', sourceId: 'thickener', targetId: 'distribution', medium: 'sewage', dn: 'DN150', sourcePort: 'T', targetPort: 'B' },
    { id: 'pipe-dewater-dist', sourceId: 'dewater', targetId: 'distribution', medium: 'sewage', dn: 'DN150', sourcePort: 'T', targetPort: 'B' },
    { id: 'pipe-dewater-dryer', sourceId: 'dewater', targetId: 'dryer', medium: 'sludge', dn: 'DN200', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-dryer-screw', sourceId: 'dryer', targetId: 'screwPump', medium: 'sludge', dn: 'DN150', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-screw-silo', sourceId: 'screwPump', targetId: 'sludgeSilo', medium: 'sludge', dn: 'DN150', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-silo-out', sourceId: 'sludgeSilo', targetId: 'sludgeOut', medium: 'sludge', dn: 'DN150', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-thickener-flow', sourceId: 'thickener', targetId: 'sludgeFlowMeter', medium: 'signal', dn: '', sourcePort: 'R', targetPort: 'L' },

    // ---- 加药：四个加药点各自接到投加点 ----
    { id: 'pipe-pac-coag', sourceId: 'pacDosing', targetId: 'coag', medium: 'chemical', dn: 'DN40', sourcePort: 'R', targetPort: 'B' },
    { id: 'pipe-pac-pump', sourceId: 'pacDosing', targetId: 'pacPump', medium: 'chemical', dn: 'DN40', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-pacpump-coag', sourceId: 'pacPump', targetId: 'coag', medium: 'chemical', dn: 'DN40', sourcePort: 'T', targetPort: 'B' },
    { id: 'pipe-pam-dewater', sourceId: 'pamDosing', targetId: 'dewater', medium: 'chemical', dn: 'DN25', sourcePort: 'T', targetPort: 'B' },
    { id: 'pipe-pam-pump', sourceId: 'pamDosing', targetId: 'pamPump', medium: 'chemical', dn: 'DN25', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-pampump-dewater', sourceId: 'pamPump', targetId: 'dewater', medium: 'chemical', dn: 'DN25', sourcePort: 'T', targetPort: 'B' },
    { id: 'pipe-naocl-disinfect', sourceId: 'naoclDosing', targetId: 'disinfect', medium: 'chemical', dn: 'DN25', sourcePort: 'T', targetPort: 'B' },
    // 碳源投加到缺氧池（补充反硝化需要的碳源，真实运行里很常见）
    { id: 'pipe-carbon-anx1', sourceId: 'carbonDosing', targetId: 'anx1', medium: 'chemical', dn: 'DN25', sourcePort: 'R', targetPort: 'T' },
    { id: 'pipe-carbon-anx2', sourceId: 'carbonDosing', targetId: 'anx2', medium: 'chemical', dn: 'DN25', sourcePort: 'B', targetPort: 'T' },

    // ---- 鼓风 / 空气管网：三台鼓风机 → 一根干管 → 两个好氧池 ----
    { id: 'pipe-transformer-vfdA', sourceId: 'transformer', targetId: 'vfdA', medium: 'power', dn: '', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-transformer-vfdB', sourceId: 'transformer', targetId: 'vfdB', medium: 'power', dn: '', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-vfdA-blowerA', sourceId: 'vfdA', targetId: 'blowerA', medium: 'power', dn: '', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-vfdB-blowerB', sourceId: 'vfdB', targetId: 'blowerB', medium: 'power', dn: '', sourcePort: 'B', targetPort: 'T' },
    // 备用鼓风机直接挂在干管上（不进变频器 —— 它是定速备机）
    { id: 'pipe-blowerA-air', sourceId: 'blowerA', targetId: 'airGauge', medium: 'air', dn: 'DN300', sourcePort: 'L', targetPort: 'L' },
    { id: 'pipe-blowerB-air', sourceId: 'blowerB', targetId: 'airGauge', medium: 'air', dn: 'DN300', sourcePort: 'L', targetPort: 'B' },
    { id: 'pipe-blowerC-air', sourceId: 'blowerC', targetId: 'airGauge', medium: 'air', dn: 'DN300', sourcePort: 'L', targetPort: 'R' },
    { id: 'pipe-air-pressure', sourceId: 'airGauge', targetId: 'airFlowMeter', medium: 'signal', dn: '', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-air-aer1', sourceId: 'airGauge', targetId: 'aer1', medium: 'air', dn: 'DN200', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-air-aer2', sourceId: 'airGauge', targetId: 'aer2', medium: 'air', dn: 'DN200', sourcePort: 'B', targetPort: 'B' },

    // ---- 除臭：预处理区 / 污泥区各一套 ----
    { id: 'pipe-grit-deodor1', sourceId: 'grit', targetId: 'deodor1', medium: 'air', dn: 'DN300', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-primary-deodor1', sourceId: 'primary', targetId: 'deodor1', medium: 'air', dn: 'DN200', sourcePort: 'L', targetPort: 'R' },
    { id: 'pipe-dryer-deodor2', sourceId: 'dryer', targetId: 'deodor2', medium: 'air', dn: 'DN300', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-thickener-deodor2', sourceId: 'thickener', targetId: 'deodor2', medium: 'air', dn: 'DN200', sourcePort: 'B', targetPort: 'L' },

    // ---- 在线仪表：每台仪表一根信号线（漏了就是"孤立符号"，校验会报） ----
    { id: 'pipe-inlet-ph', sourceId: 'grit', targetId: 'phInlet', medium: 'signal', dn: '', sourcePort: 'T', targetPort: 'B' },

    { id: 'pipe-aer1-do', sourceId: 'aer1', targetId: 'doAer1', medium: 'signal', dn: '', sourcePort: 'T', targetPort: 'B' },
    { id: 'pipe-aer2-do', sourceId: 'aer2', targetId: 'doAer2', medium: 'signal', dn: '', sourcePort: 'T', targetPort: 'T' },
    { id: 'pipe-sec2-mlss', sourceId: 'sec2', targetId: 'mlssGauge', medium: 'signal', dn: '', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-disinfect-turbidity', sourceId: 'disinfect', targetId: 'turbidityGauge', medium: 'signal', dn: '', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-meter-reclaimed', sourceId: 'meter', targetId: 'outletFlowMeterB', medium: 'signal', dn: '', sourcePort: 'T', targetPort: 'L' },

    // ---- 出水四项在线监测：四台各一根信号线，都从出水管上取 ----
    { id: 'pipe-meter-cod', sourceId: 'meter', targetId: 'codAnalyzer', medium: 'signal', dn: '', sourcePort: 'B', targetPort: 'L' },
    { id: 'pipe-meter-nh3', sourceId: 'meter', targetId: 'nh3Analyzer', medium: 'signal', dn: '', sourcePort: 'B', targetPort: 'L' },
    { id: 'pipe-meter-tp', sourceId: 'meter', targetId: 'tpAnalyzer', medium: 'signal', dn: '', sourcePort: 'B', targetPort: 'L' },
    { id: 'pipe-meter-tn', sourceId: 'meter', targetId: 'tnAnalyzer', medium: 'signal', dn: '', sourcePort: 'B', targetPort: 'L' },

    // ---- 再生水回用：从出水计量后分出一路，加压送去回用 ----
    // ⚠️ 出口点必须和第二根一样是 `T`（表的**上边**）：再生水是从出水管上**往上**引出去的，
    //    而泵与再生水计量都在 y=1015（表在 y=1320）。
    //    原来写的是 `B`（表的下边）+ 泵的 `T`，而泵在表的**上方** ——
    //    那根线会先从表底出来、绕一圈再回到上面的泵，而且穿过表体。
    //    这是**早先就有的错**：原坐标里泵(4280,700)也在表(4430,910)上方，同样对不上。
    { id: 'pipe-meter-reclaimedPump', sourceId: 'meter', targetId: 'reclaimedPump', medium: 'effluent', dn: 'DN300', sourcePort: 'T', targetPort: 'B' },

    // ---- 除臭风机：给两套除臭装置送风 ----
    { id: 'pipe-fan1-deodor1', sourceId: 'deodorFan1', targetId: 'deodor1', medium: 'air', dn: 'DN250', sourcePort: 'R', targetPort: 'L' },
    { id: 'pipe-fan2-deodor2', sourceId: 'deodorFan2', targetId: 'deodor2', medium: 'air', dn: 'DN250', sourcePort: 'R', targetPort: 'L' },

    // ---- 超越管：沉砂池 → 超越阀 → 厌氧池（绕过初沉池） ----
    { id: 'pipe-grit-bypass', sourceId: 'grit', targetId: 'bypassValve', medium: 'sewage', dn: 'DN700', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-bypass-ana1', sourceId: 'bypassValve', targetId: 'ana1', medium: 'sewage', dn: 'DN700', sourcePort: 'R', targetPort: 'B' },
    // 超越管也有一条去第二组（两组都要能吃到原水碳源）
    { id: 'pipe-bypass-ana2', sourceId: 'bypassValve', targetId: 'ana2', medium: 'sewage', dn: 'DN700', sourcePort: 'B', targetPort: 'L' },
  ],
};

/** 两组并联线的 id 表（`server/agents/scenarios.ts` 的讲稿按组分段讲）。 */
export const BIO_TRAINS = { a: TRAIN_1, b: TRAIN_2 } as const;
