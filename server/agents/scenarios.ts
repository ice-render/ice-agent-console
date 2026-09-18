/**
 * 剧本：把用户一句话（以及上下文）映射成一份"工具卡计划"。
 *
 * **这是 M2 会被替换掉的那一层。** 现在它是几个 if-else，将来这里会是一次模型调用，
 * 但产出的 `ToolCardPlan` 形状不变——所以它下面的一切都不用动。
 *
 * 之所以单独放一个文件而不是塞进 scripted.ts：等 M2 加 `llm.ts` 的时候，
 * 两个实现摆在一起，接口一致这件事一眼就能看出来。
 */
import {
  COLLECT_INPUT_TOOL,
  RENDER_CHART_TOOL,
  RENDER_DIAGRAM_TOOL,
  STATE_CHART_KEY,
  STATE_DIAGRAM_KEY,
  STATE_FORM_KEY,
} from '../../shared/contract';
import {
  UPGRADE_BRIDGE_PIPES,
  UPGRADE_PIPES,
  UPGRADE_REMOVED_PIPE_IDS,
  UPGRADE_REMOVED_UNIT_IDS,
  UPGRADE_UNITS,
  WATER_PROCESS_DSL,
} from '../../shared/water-process-case';
import type { ToolCardPlan } from './dsl-to-events';

/**
 * 一张表 + encoding，这就是 ice-chart-dsl 想要的形态。
 *
 * ⚠️ **题材必须与工艺图有关系**（2026-09-18 改）：原先这里是"各渠道月度销量"，
 * 而它要浮在一张污水处理工艺流程图上 —— 两者毫无业务关联，看着就是硬凑的。
 * 现在换成**图上某个单元的运行数据**：出水 COD 在线（`codAnalyzer` / AIT-106）的近 6 日读数，
 * 并且卡片会锚定到那个单元上（见 `ToolCardPlan.anchor`）。
 *
 * 判据很简单：**把图遮住，这张卡片还说得通吗？** 说得通就说明它没绑在图上。
 */
const COD_TREND_DSL = {
  schemaVersion: 1,
  kind: 'bar',
  title: '出水 COD · 近 6 日（限值 50 mg/L）',
  data: {
    columns: ['日期', 'COD'],
    rows: [
      ['9-12', 34],
      ['9-13', 31],
      ['9-14', 38],
      ['9-15', 46],
      ['9-16', 36],
      ['9-17', 33],
    ],
  },
  encoding: { x: '日期', y: 'COD' },
};

/** 故意写错的一版：表里的列叫「COD」，模型却写成了「COD浓度」。用来走自修复回路。 */
const BROKEN_DSL = {
  ...COD_TREND_DSL,
  title: '出水 COD（第一版，写错了列名）',
  encoding: { x: '日期', y: 'COD浓度' },
};

/**
 * 故意写错的图 DSL：加了一个「隔油池」。
 *
 * 为什么挑这个错：它**看起来完全合理** —— 隔油池是真实存在的构筑物，
 * 只是不在这套 31 种符号的记号集里（那套是 AAO 工艺线的记号）。
 * 这正是要演示的那类错误：不是拼写错误，而是"用了一套记号里没有的东西"。
 * 校验器会指出未知种类并**列出合法值**，agent 据此就能修。
 */
const BROKEN_DIAGRAM_DSL = {
  ...WATER_PROCESS_DSL,
  units: [
    ...WATER_PROCESS_DSL.units,
    { id: 'greaseTrap', kind: 'greaseTrap', name: '隔油池', tag: 'GT-101', left: 240, top: 240 },
  ],
};

/**
 * 实时流剧本的数据源：**出水计量井的瞬时流量**。
 *
 * 量级按这座厂的设计规模（10 万 m³/日）算：日均 ≈ 4167 m³/h，
 * 所以列里的数在 4100 上下波动 —— 旧版写的是 92/105/148（那是老题材"平台吞吐量"的量级），
 * 放在一座污水厂的出水计量上不成立。
 *
 * x 刻意用**数值轴**（秒）而不是类目轴（月份），原因是查过 `appendData` 的实现：
 * 它只往 `series.data` 末尾 concat，**不碰 `xAxis.data`**。
 * 而类目轴编译出来的 `series.data` 是纯数值数组、类目名单独存在 `xAxis.data` 里，
 * 所以往类目轴追加一个新类目用 `appendData` 是错的——得同时补 x 轴。
 *
 * 数值轴编译出来是 `xAxis.type='value'` + `series.data=[[x,y],...]`，
 * 这才是 `appendData` 被设计出来服务的场景（"实时数据流专用"）。
 * 视图层对此有防御：认出类目轴就走全量 `setOption`（见 src/view/chart-adapter.ts）。
 */
const OUTLET_FLOW_DSL = {
  schemaVersion: 1,
  kind: 'line',
  title: '出水计量 FIT-101 · 实时流量（m³/h）',
  data: {
    columns: ['时刻(秒)', '流量(m³/h)'],
    rows: [
      [1, 4020],
      [2, 4110],
      [3, 4372],
      [4, 4264],
      [5, 4156],
      [6, 4084],
    ],
  },
  encoding: { x: '时刻(秒)', y: '流量(m³/h)' },
};

/**
 * 人机回环要收集的参数。
 *
 * 这一份是 `ice-web-components-dsl` 的文档 —— agent 只声明"要问什么"，
 * 表单怎么排、控件怎么建、校验怎么跑，都由那个包负责。
 */
const CONFIRM_FORM_DSL = {
  schemaVersion: 1,
  kind: 'form',
  title: '进水泵站 P-101 · 运行参数下发',
  description: '确认后把运行参数下发给进水泵 P-101（图上会高亮这台泵）。',
  fields: [
    {
      name: 'station',
      type: 'select',
      label: '泵组',
      required: true,
      options: [
        { value: 'pump-1', label: '一号进水泵 P-101' },
        { value: 'pump-2', label: '二号进水泵 P-102（备用）' },
      ],
    },
    {
      name: 'mode',
      type: 'radio-group',
      label: '控制方式',
      default: 'auto',
      options: [
        { value: 'auto', label: '自动（按集水井液位）' },
        { value: 'manual', label: '远程手动' },
      ],
    },
    {
      name: 'flow',
      type: 'number',
      label: '目标流量 (m³/h)',
      required: true,
      // 量程按泵的能力曲线来：这座厂进水日均 ≈ 4167 m³/h（两台并联，单泵 ~2083），单泵 800~2600
      min: 800,
      max: 2600,
      step: 10,
      default: 2080,
    },
    {
      name: 'level',
      type: 'number',
      label: '集水井目标液位 (m)',
      min: 0.5,
      max: 6,
      step: 0.1,
      default: 3.2,
    },
    { name: 'note', type: 'textarea', label: '备注', maxLength: 120, placeholder: '选填：填写依据（如当班液位、进水水量）' },
  ],
  submitText: '确认下发',
};

/**
 * **加药与工艺参数调整单。**
 *
 * 这张表是"智慧水务平台上真会开的一张单子"：当班发现出水波动或药耗偏高，
 * 工艺员提调整申请，值班长复核后下发到加药间。表单锚定图上那台 PAC 加药装置（DU-101），
 * 所以"填的数字对着哪个设备"在图上是看得见的。
 *
 * 改造前这里叫「第二批控件」，字段是主题色 / 优先级 / 触发时间 / 维护窗口 / 省市区……
 * 那一版是**控件原型页**（目的是把 0.3.0 新接的 9 个字段类型各放一个），
 * 问题是它跟水务业务毫无关系 —— 表单浮在一张污水处理工艺图上，看着就是硬凑的。
 *
 * 现在字段按单据本身的语义来，**覆盖面一条没丢**：`ice-web-components-dsl` 0.3.0
 * 新接的 9 个类型（color / segmented / time / date-range / cascader / tree-select /
 * transfer / rate / autocomplete）在这张单子上各有一个，另外补了
 * number（投加量）/ slider（投加浓度）/ 多选 select（关联设备）/ textarea（备注）。
 *
 * 「HMI 标识色」不是凑数的配置项：组态屏上每个加药点都要指定一个显示色，
 * 用它区分工段（这是水务平台组态页的常规字段）。
 *
 * 全部字段都**没有写宽度** —— 那是宿主 + DSL 的事（见该包 README §8.1）；
 * `options` 也一律用裸字符串（除了需要 label 的），形状差异由编译期归一化。
 */
const DOSING_FORM_DSL = {
  schemaVersion: 1,
  kind: 'form',
  title: '加药与工艺参数调整单',
  description: '提交后进「待复核」，值班长确认后再下发到加药间。',
  fields: [
    {
      name: 'hmiColor',
      type: 'color',
      label: 'HMI 标识色',
      default: '#61D9FB',
      options: ['#61D9FB', '#0F172A', '#16A34A', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6'],
    },
    {
      name: 'urgency',
      type: 'segmented',
      label: '紧急程度',
      default: 'normal',
      options: [
        { value: 'normal', label: '常规' },
        { value: 'urgent', label: '加急' },
        { value: 'immediate', label: '立即执行' },
      ],
    },
    { name: 'startAt', type: 'time', label: '每日起始时刻', format: 'HH:mm', default: '08:00' },
    {
      name: 'period',
      type: 'date-range',
      label: '计划执行周期',
      required: true,
      default: ['2026-09-19', '2026-09-25'],
    },
    {
      name: 'plant',
      type: 'cascader',
      label: '厂区 / 工段',
      placeholder: '选厂区 / 工段',
      separator: ' / ',
      options: [
        {
          value: 'plant-1',
          label: '一号污水厂',
          children: [
            { value: 'pretreat', label: '预处理工段' },
            { value: 'bio', label: '生化段（AAO）' },
            { value: 'advanced', label: '深度处理工段' },
            { value: 'sludge', label: '污泥工段' },
          ],
        },
      ],
    },
    {
      name: 'dosingPoint',
      type: 'tree-select',
      label: '加药点',
      placeholder: '按加药间选',
      showSearch: true,
      options: [
        {
          value: 'dosing-room',
          label: '加药间',
          children: [
            { value: 'pac-point', label: 'PAC 投加点（混凝沉淀池）' },
            { value: 'pam-point', label: 'PAM 投加点（污泥脱水）' },
            { value: 'carbon-point', label: '碳源投加点（缺氧池）' },
          ],
        },
      ],
    },
    {
      name: 'chemical',
      type: 'autocomplete',
      label: '药剂',
      placeholder: '输入以筛选',
      options: ['PAC（聚合氯化铝）', 'PAM（聚丙烯酰胺）', '次氯酸钠', '乙酸钠（碳源）', '液氧'],
    },
    {
      name: 'dose',
      type: 'number',
      label: '投加量 (L/h)',
      min: 0,
      max: 2000,
      step: 10,
      default: 120,
    },
    { name: 'doseRate', type: 'slider', label: '投加浓度 (%)', min: 1, max: 30, default: 10 },
    {
      name: 'reasons',
      type: 'transfer',
      label: '调整原因',
      default: ['出水波动'],
      options: ['出水波动', '进水冲击', '低温运行', '污泥膨胀', '药耗偏高', '节能降耗'],
    },
    { name: 'risk', type: 'rate', label: '风险等级', max: 5, default: 2 },
    {
      name: 'devices',
      type: 'select',
      mode: 'multiple',
      label: '关联设备',
      default: ['DU-101'],
      options: ['DU-101', 'DU-102', 'DU-103', 'DU-104', 'P-401', 'P-402'],
    },
    { name: 'note', type: 'textarea', label: '备注', maxLength: 120, placeholder: '选填：填写依据（如当班化验值）' },
  ],
  submitText: '提交调整单',
};

/** 图表卡的公共部分。 */
function chartCard(payload: unknown, rest: Omit<ToolCardPlan, 'tool' | 'payload' | 'stateKey'>): ToolCardPlan {
  return { tool: RENDER_CHART_TOOL, payload, stateKey: STATE_CHART_KEY, ...rest };
}

/** 图卡的公共部分（与 `chartCard` 同构，只是工具名与 stateKey 不同）。 */
function diagramCard(payload: unknown, rest: Omit<ToolCardPlan, 'tool' | 'payload' | 'stateKey'>): ToolCardPlan {
  return { tool: RENDER_DIAGRAM_TOOL, payload, stateKey: STATE_DIAGRAM_KEY, ...rest };
}

/**
 * 判断这句话是不是在问水务工艺图。
 *
 * 抽成函数是因为它要用在**两个**地方：选剧本，以及"故意画错"时决定画错哪种图。
 * 两处各写一份正则迟早会漂。
 */
function isWaterAsk(text: string): boolean {
  return /污水|水厂|给排水|水处理|工艺图|工艺流程|工艺流程|AAO|污泥|格栅|生化池|二沉池|厌氧|缺氧|好氧/.test(text);
}

/**
 * 讲解用的档位。
 *
 * 为什么是**绝对**倍率而不是"放大一档"：一条十几拍的解说里叠三次相对缩放，
 * 倍率就飘到不可预期；而写死档位之后，讲稿的任何一拍停在哪一屏都是确定的
 * —— 单测与 e2e 也才断言得了。
 *
 * | 档 | 值 | 用在哪 | 一屏能看到 |
 * |---|---|---|---|
 * | 全貌 | `{ direction: 'fit' }`（**不是**一个常数） | 开场 / 收尾：整张图纸（含污泥线、事故水、加药间） | 全部图元，无裁剪 |
 * | 分段 | 0.85 | 讲一条工艺段（预处理 / 生化 / 深度处理） | 约 1200 世界像素 = 4~5 个池子 |
 * | 单格 | 1.5 | 讲一个池子：位号、名称、进出管线都读得清 | 约 700 = 1~2 个池子 |
 *
 * ## 为什么"全貌"档不再是常数（这是实测踩出来的）
 *
 * 它原本是 `0.22`，一个照着"4820 宽的世界 ÷ 可视区 1048"手算出来的数。两个问题：
 *
 * 1. **算不准**：恰好装得下的倍率取决于可视区宽度（窗口尺寸 - 面板遮盖）、
 *    图元自身的尺寸（符号有宽度，世界跨度是 4820 + 符号），以及留白。手算的那点余量
 *    被这些吃掉之后，0.22 实际*略微*超宽 —— 而真正的偏差不在这儿（见下条）。
 * 2. **`to` 不重新取景，只改倍率**：它的平移是"保住当前可视区中心那个世界点"，
 *    这样"先 `pointAt` 把目标移到中心、再 `to` 放大"才能把目标留在原地。
 *    可"看整张图"要的是**图纸中心**落在可视区中心 —— 从生化段的特写推远时，
 *    中心还在生化段上，于是倍率对了、位置全错：实测左侧 **1870 世界像素**
 *    （整个预处理段）被推出屏幕左边界。画面看起来只是个"远景"，不报错，也不好看出来。
 *
 * 所以"全貌"档改用 `{ direction: 'fit' }`：倍率与平移**一起**由"全部图元的包围盒"算出来。
 * 它与界面上那个"看整张图纸"（`StageView.fitAll()`）共用同一份计算。
 *
 * 另两档仍是常数 —— 它们要的是"一个池子占多大"，那本来就是个视觉选择，不是几何约束。
 */
const VIEW_STAGE = 0.85;
const VIEW_UNIT = 1.5;

/** "把整张图纸框进来"。别换回 `to` + 常数倍率，理由见上面的注释。 */
const VIEW_ALL_FIT = { direction: 'fit' } as const;

/**
 * 开场白里要报的**案例规模**——从 `WATER_PROCESS_DSL` 现算，不写死。
 *
 * ⚠️ 这几个数曾经是手写的，图从 34/37 扩到两组生化并联之后，画面上是 68 个符号、
 * 讲稿里还在说 34 个 —— **用户一眼就看出讲稿和图对不上**。规模是数据的函数，
 * 手抄一份等于给自己埋一个必定过期的副本；现算之后改坐标/加池子都不用回来改文案。
 */
const CASE_SCALE = {
  units: WATER_PROCESS_DSL.units.length,
  pipes: WATER_PROCESS_DSL.pipes.length,
  kinds: new Set(WATER_PROCESS_DSL.units.map((u) => u.kind)).size,
  mediums: new Set(WATER_PROCESS_DSL.pipes.map((p) => p.medium)).size,
};

/**
 * **内置案例：污水处理工艺流程图**（`ice-entity-designer` 画的工艺图）。
 *
 * ## 这是"讲到哪里，镜头推到哪里"的那一条
 *
 * 它和另两条水务剧本的区别是**它自己带着图**（`diagramCard`），而另两条只带讲解
 * —— 见下面 `zoomPlan` / `blinkPlan` 的注释。
 *
 * 节拍排成"**远看 → 推近看**"：
 *
 * 1. 先 `{ direction: 'fit' }` 把整张图收进视野（开页那一屏是按 focus 取的近景，看不到污泥线）；
 * 2. 然后**按工艺段推进**：预处理 → 生化 → 二沉 → 深度处理 → 污泥 → 事故水；
 *    每进一段先把倍率放到"分段"档，讲到具体池子时再推"单格"档；
 * 3. 每一拍都 `pointAt` 到讲的那个单元 —— 于是镜头**平移**过去（`pointAt` 会居中）
 *    并且**高亮**它。两者叠起来就是"镜头跟着讲解走"。
 *
 * ⚠️ 每一拍都写 `zoom` 是刻意的，不是冗余：`to` 是幂等的，写了就等于"这一拍之后
 * 一定在 0.85 档"，不用去数前面发生过什么。加拍、删拍、调换顺序都不用重算倍率。
 *
 * 收尾回到"全貌"档：讲完了让图纸整体留在视野里，比停在一个池子的特写上更像个结尾。
 */
/**
 * **工艺图讲解的节拍表**（导出是为了让测试能读它 —— 见 `tests/diagram-narration.test.ts`）。
 *
 * 唯一容易漂的地方是**覆盖**：图上有的、主流程上的处理单元，台词里必须点得到。
 * 已经漂过两次 —— 粗格栅与配水井画在图上、11 站台词一次没点名；后来加了中间提升泵，
 * 镜头走过去、嘴上也没提。所以把这份表抽出来，交给测试盯。
 */
export const WATER_WALK_BEATS: Array<{ text: string; pointAt?: string; blink?: boolean; zoom?: any }> = [
    {
      text:
        '先把整张图框进来 —— 上面那条是水线主线，中间一条是深度处理，' +
        '最下面是污泥线，右边还有一条事故水支路。',
      zoom: { ...VIEW_ALL_FIT },
    },
    {
      text: '从最左边开始。厂外进水先过粗格栅拦大块杂物，再经进水泵加压、出口接止回阀，然后进细格栅挡小颗粒：',
      pointAt: 'inlet',
      zoom: { direction: 'to', scale: VIEW_UNIT },
    },
    {
      text:
        '接着是曝气沉砂池去掉砂粒，再到初沉池把悬浮物沉下去 —— ' +
        '这两格是预处理段的主体；出水进配水井，在那里一分为二给并联的两组生化线：',
      pointAt: 'primary',
      zoom: { direction: 'to', scale: VIEW_STAGE },
    },
    {
      text:
        '进生化段。厌氧池是释磷的地方 —— 聚磷菌在这里把磷放出来，' +
        '这是后面能生物除磷的前提：',
      pointAt: 'ana1',
      zoom: { direction: 'to', scale: VIEW_UNIT },
    },
    {
      text:
        '缺氧池靠内回流把硝态氮还原成氮气，这是脱氮的主战场。' +
        '注意上方那个内回流调节阀，混合液就是从好氧池经它回到这里的：',
      pointAt: 'anx1',
      zoom: { direction: 'to', scale: VIEW_UNIT },
    },
    {
      text: '好氧池完成硝化与有机物降解，鼓风机房从最上面通过空气管给它供氧：',
      pointAt: 'aer1',
      zoom: { direction: 'to', scale: VIEW_UNIT },
    },
    {
      text:
        '二沉池做泥水分离。上清液去深度处理，污泥一路回流到厌氧池、' +
        '一路去浓缩脱水 —— 池子底下那几根管子就是这几路：',
      pointAt: 'sec1',
      zoom: { direction: 'to', scale: VIEW_UNIT },
    },
    {
      text:
        '二沉池的上清液不能自己流进深度处理 —— 中间那几台中间提升泵（两台互备）把水头提上去，' +
        '这也是全流程里唯一抬水头的一段：',
      pointAt: 'midPumpA',
      zoom: { direction: 'to', scale: VIEW_UNIT },
    },
    {
      text:
        '深度处理段从左到右：加药 → 混凝沉淀 → 滤布滤池 → 消毒接触池，除磷、控 SS、杀菌。' +
        '滤池底下那台是反冲洗泵：滤池运行一段时间要反洗一次，反洗水回到配水井再利用：',
      pointAt: 'coag',
      zoom: { direction: 'to', scale: VIEW_STAGE },
    },
    {
      text: '出水前必须过在线水质监测与计量，然后经出水阀从排放口排出去：',
      pointAt: 'analyzer',
      zoom: { direction: 'to', scale: VIEW_STAGE },
    },
    {
      text:
        '再看最下面那条污泥线：浓缩 → 脱水 → 螺杆泵输送 → 料仓 → 外运，' +
        '脱水机房的臭气由除臭装置抽走。注意还有两条回流水 —— ' +
        '浓缩上清液与脱水滤液都打回配水井，不然前端的水量算不平：',
      pointAt: 'thickener',
      zoom: { direction: 'to', scale: VIEW_STAGE },
    },
    {
      text:
        '最后是右边那条事故水支路：出水一旦超标就切进事故池，' +
        '再由回流泵打回厌氧池重来一遍 —— 所以它绕回的是生化段，不是排放口：',
      pointAt: 'accidentTank',
      zoom: { direction: 'to', scale: VIEW_STAGE },
    },
    {
      text:
        '整张图是 `ice-entity-designer` 画的，不是图片。滚轮可以缩放、空白处拖拽可以平移 —— ' +
        '世界尺寸约 8600×4200，是拖着看而不是缩略图。',
      zoom: { ...VIEW_ALL_FIT },
    },
];

function waterProcessPlan(): ToolCardPlan {
  return diagramCard(WATER_PROCESS_DSL, {
    intro:
      '这是某 10 万 m³/d 市政污水厂的全流程：AAO 两组并联 + 混凝沉淀 + 滤布滤池 + 消毒。' +
      `${CASE_SCALE.units} 个单元、${CASE_SCALE.pipes} 段管线，` +
      `用满了 ${CASE_SCALE.kinds} 种工艺符号与 ${CASE_SCALE.mediums} 种介质线型。` +
      '我按工艺段走一遍，镜头会跟着推近。',
    beats: WATER_WALK_BEATS,
  });
}

/**
 * 剧本：**让 AI 下命令缩放视图**。
 *
 * ⚠️ 它**不画图** —— `TextOnlyCardPlan`（没有 `tool` / `payload`）。
 * 这是这次改动的一条硬规矩：**与工艺图有关的示例都作用在那一张已经画好的图上**，
 * 不再各自吐一份 DSL。理由有两条：
 *
 * 1. 那份图在 boot 时就已经画好了，重发一遍纯属浪费（虽然按内容比对不会重建，
 *    但 tool call 本身要流式传 8KB 参数、还会在对话里多一条条目）；
 * 2. "缩放/闪烁"本来就是**查看动作**，跟"画一张图"不是一回事。让它们挤在
 *    一次 tool call 里，等于说"想放大就得重画一遍" —— 那正是这次布局反转要否掉的东西。
 *
 * 所以这三条水务剧本的分工是：`waterProcessPlan` 带图（演示 DSL 流式传进来），
 * 另两条只带讲解 + 画布命令（演示**命令作用在已有的图上**）。
 */
function zoomPlan(): ToolCardPlan {
  return {
    intro: '好，我把镜头推近一点看几个关键段 —— 注意我没有重新画图，动的是同一张。',
    beats: [
      { text: '先推到全貌，看看整张图纸的骨架：', zoom: { ...VIEW_ALL_FIT } },
      {
        text: '进到生化段。两条线是并联的，A 线在上一行、B 线在下一行 —— 先看 A 线，AAO 这三格的顺序不能颠倒：',
        pointAt: 'ana1',
        zoom: { direction: 'to', scale: VIEW_UNIT },
      },
      {
        text: '再往右推到二沉池。注意它是最高的一个符号，因为泥水分离在这里发生：',
        pointAt: 'sec1',
        zoom: { direction: 'to', scale: VIEW_UNIT },
      },
      { text: '拉回分段档，看深度处理那一整条线：', pointAt: 'coag', zoom: { direction: 'to', scale: VIEW_STAGE } },
      {
        text: '复位，回到刚画出来时的那一屏（按 DSL 里 `viewport.focus` 适配的取景，不是 1 倍）：',
        zoom: { direction: 'reset' },
      },
      {
        text:
          '这几下都不是新的 tool call —— 缩放是**瞬时查看动作**，走的是 CUSTOM 事件通道，' +
          '跟「指着讲」同一类。所以它不进 `state`：刷新页面后"当时放大到几倍"并不需要被恢复。',
      },
    ],
  };
}

/**
 * 剧本：**让 AI 下命令把某个图元高亮闪烁**。
 *
 * 同样不画图（理由见 `zoomPlan`）。闪烁是 `point_at` 的一个参数（`blink: true`），
 * 不是另一个工具 —— "定位 + 强调"本来就是一次动作，拆成两个工具会出现"闪一个没被指到的东西"。
 *
 * 高亮是**鲜黄**的，不是家族品牌冰蓝：图纸本身就是蓝的（水线浅蓝、出水青绿），
 * 主色叠上去跟"某种介质管线"长得一样，读图的人分不出哪个是强调。
 */
function blinkPlan(): ToolCardPlan {
  return {
    intro:
      '我把 AAO 的三个池子依次点出来、各闪一下 —— 用的是同一个 `point_at`，只是多带一个 `blink`。' +
      '高亮用的是鲜黄，因为这张图上蓝绿青都被介质占用完了。',
    beats: [
      { text: '厌氧池：聚磷菌在这里释磷，是生物除磷的前提 —— 看这个在闪的黄框：', pointAt: 'ana1', blink: true, zoom: { direction: 'to', scale: VIEW_UNIT } },
      { text: '缺氧池：内回流把硝态氮带过来还原成氮气，脱氮的主战场：', pointAt: 'anx1', blink: true, zoom: { direction: 'to', scale: VIEW_UNIT } },
      { text: '好氧池：硝化与有机物降解都在这儿，也是耗氧最多的一段：', pointAt: 'aer1', blink: true, zoom: { direction: 'to', scale: VIEW_UNIT } },
      { text: '这三个池子合起来就是 AAO，顺序不能颠倒 —— 颠倒了两边都做不成：', zoom: { direction: 'to', scale: VIEW_STAGE } },
      {
        text:
          '闪的是盖在符号上的那层底块：它的透明度用引擎原生的**声明式动画**驱动' +
          '（`alternate` + 偶数轮 yoyo），不是应用层手写的逐帧补间。',
      },
    ],
  };
}

/** 默认剧本：柱状图 + 画完之后指着 3 月讲。 */
type PatchOp = { op: string; path: string; value?: any };

/**
 * **下标游标**：编补丁时用来算"现在这个 id 在第几位"。
 *
 * ## 为什么必须有它（这是这一版踩到的最隐蔽的坑）
 *
 * JSON Patch 的 `remove` 只认**下标**，而下标会在每次增删之后变化。
 * 更麻烦的是 `STATE_DELTA` 是**顺序应用**的 —— 一条 run 里可能有好几拍、
 * 每拍一批补丁，后一批的下标必须相对**前一批之后**的那份文档算。
 *
 * 不这么做会怎样（实测）：第一拍删掉 3 根管线，第二拍还按**基准图**的下标
 * 去删 `pipe-filter-disinfect`（基准里是 29）—— 那个下标现在已经指向另一根管线了。
 * 而 `remove` 一个**存在的**下标**不报错**，于是它静默删掉了不该删的那根，
 * 图看着"变了"，但变错了。
 *
 * 所以这里维护一份"id 列表"的镜像，每发一批就同步删/加，之后的下标都从它算。
 * 它与真实文档的一致性**只在编补丁期间**需要 —— 真正应用补丁的还是 reducer。
 *
 * ## 两条规矩
 *
 * 1. **降序删**：`remove` 之后后面元素的下标会前移，升序删会错位。
 *    所以一批里先删靠后的，前面的下标就不受影响（镜像也按同样顺序同步）。
 * 2. **增删都要同步镜像**：只删不记、或只加不记，后面算出来的下标立刻就是错的。
 */
class IndexCursor {
  private units: string[];
  private pipes: string[];

  constructor(units: ReadonlyArray<{ id: string }>, pipes: ReadonlyArray<{ id: string }>) {
    this.units = units.map((u) => u.id);
    this.pipes = pipes.map((p) => p.id);
  }

  removePipes(ids: string[]): PatchOp[] {
    return this.__remove(this.pipes, ids, '/diagram/pipes');
  }

  removeUnits(ids: string[]): PatchOp[] {
    return this.__remove(this.units, ids, '/diagram/units');
  }

  /** 追加到末尾（补丁用 `/-`）—— 已有元素的下标不受影响，但镜像要记住它们存在。 */
  addUnits(ids: string[]): void {
    this.units.push(...ids);
  }
  addPipes(ids: string[]): void {
    this.pipes.push(...ids);
  }

  private __remove(list: string[], ids: string[], base: string): PatchOp[] {
    const found = ids
      .map((id) => ({ id, index: list.indexOf(id) }))
      .filter((item) => {
        if (item.index < 0) throw new Error(`[scenarios] 图里没有「${item.id}」，补丁没法构造`);
        return true;
      })
      // ⚠️ 降序：见类注释第 1 条
      .sort((a, b) => b.index - a.index);

    const ops = found.map((item) => ({ op: 'remove', path: `${base}/${item.index}` }));
    // 同步镜像（同样是降序，否则 splice 会错位）
    for (const item of found) list.splice(item.index, 1);
    return ops;
  }
}

/**
 * 删单元时**顺带要删的管线**（两端指向它的那些）。
 *
 * 为什么必须显式列出：渲染层确实会级联（`FlowDesigner.remove(unitId)` 顺手删掉
 * 挂在它两端的连线），但那只保证**画面**干净 —— `STATE_DELTA` 改的是那份 **state 文档**，
 * 而 JSON Patch 只会把 `units` 数组里那一项拿掉，**管线数组原封不动**。
 *
 * 于是文档里会留下"两端指向一个不存在的单元"的管线。后果有两层：
 * - 立刻：`validateDiagramDsl` 报 `引用了不存在的单元`（本仓的守卫会拦下来）；
 * - 以后：任何一次"从 state 重建这张图"都会在建那几根管线时抛
 *   （`createPipe` 要求两端已存在）。
 *
 * 所以**补丁要表达完整意图**，别指望渲染层的级联去补文档 —— 那两条路径服务于
 * 不同的东西，混起来就是一个走两天才浮现的坑（这一条也是实测踩到的）。
 */
function pipesTouching(
  pipes: ReadonlyArray<{ id: string; sourceId: string; targetId: string }>,
  unitIds: string[]
): string[] {
  return pipes
    .filter((pipe) => unitIds.indexOf(pipe.sourceId) >= 0 || unitIds.indexOf(pipe.targetId) >= 0)
    .map((pipe) => pipe.id);
}

/** `viewport.focus` 里也要把被删的单元摘掉，否则守卫会报"引用了不存在的单元"。 */
function focusRemovalOps(
  focus: ReadonlyArray<string>,
  removedUnitIds: string[]
): PatchOp[] {
  return focus
    .map((id, index) => ({ id, index }))
    .filter((item) => removedUnitIds.indexOf(item.id) >= 0)
    .sort((a, b) => b.index - a.index)
    .map((item) => ({ op: 'remove', path: `/diagram/viewport/focus/${item.index}` }));
}

/** 追加图元（顺序：先单元、再管线 —— `createPipe` 要求两端已存在）。 */
function appendOps(units: ReadonlyArray<any>, pipes: ReadonlyArray<any>): PatchOp[] {
  return [
    ...units.map((u) => ({ op: 'add', path: '/diagram/units/-', value: u })),
    ...pipes.map((p) => ({ op: 'add', path: '/diagram/pipes/-', value: p })),
  ];
}

/**
 * 剧本：**提标改造 —— 动态增删图元**。
 *
 * ## 为什么这是最能说明"图是活的"的一条
 *
 * 前面所有剧本都只在**已有的图**上动镜头或改高亮，图元本身一个没变。
 * 这一条改的是图的**结构**：拆掉初沉池、改接主管、加三个提标单元。
 * 而它走的**不是**"重画一张新图"，是 `STATE_DELTA` + JSON Patch 的增量：
 * 三次 `createSymbol`、几次 `remove`，**图层不重建、视口不重置**。
 *
 * ## 补丁的构造顺序（每一步都踩过）
 *
 * 1. **先删管线、再删单元**。删单元时 `FlowDesigner.remove` 会级联删掉两端的管线，
 *    所以反过来做的第二批 `remove` 会落到"已经不在了"的下标上 ——
 *    而 `remove` 一个不存在的下标**不报错**，会静默删掉旁边的那个。
 * 2. `remove` 的 path 用**下标**（协议如此），下标由 `indexOfUnit` 从 id 现算。
 * 3. 加单元 / 管线都用 `/-` 追加 —— 图元的顺序对渲染没影响（位置在 `left/top` 里）。
 *
 * ## 三拍讲的是三件事
 *
 * | 拍 | 补丁 | 讲什么 |
 * |---|---|---|
 * | 1 | 删 `primary` + 加 `pipe-grit-dist` | 拆初沉池：碳源留给生化段（**拆一处、接一处**） |
 * | 2 | 删 `pipe-filter-disinfect` + 加 3 个单元 + 4 根管线 | 提标改造：臭氧 → 活性炭 → 超滤 |
 * | 3 | （无补丁，只推镜头） | 收尾：图变了，但**没有重画** |
 *
 * ⚠️ **两批补丁的下标基准不同**：`STATE_DELTA` 是顺序应用的，第一拍删完之后
 * 第二拍的下标已经整体前移了。所以第二拍的下标相对"第一拍之后的文档"算
 * （`IndexCursor` 干的就是这件事）。拿基准图的下标去编第二拍，会**删错管线且不报错**。
 *
 * ⚠️ 补丁要**表达完整意图**：删一个单元得连带删它的管线、还要把 `viewport.focus`
 * 里的它摘掉。渲染层虽然会级联（`designer.remove` 顺手删两端连线），
 * 但那只保证画面干净 —— `state` 文档是另一条账。详见 `pipesTouching`。
 */
function upgradePlan(): ToolCardPlan {
  const base = WATER_PROCESS_DSL;

  // ⚠️ 补丁必须**逐拍按当前状态**编，不能都拿基准图的下标 —— 见 `IndexCursor`。
  const cursor = new IndexCursor(base.units, base.pipes);

  // ---- 第一拍：拆初沉池 + 补一根连通管（拆一处、接一处） ----
  // 删单元要**连带删掉挂在它身上的三根管线**，并把 `viewport.focus` 里的它摘掉 ——
  // 三样都写全了文档才自洽（理由见 `pipesTouching` 的注释）。
  const dropPrimary: PatchOp[] = [
    ...cursor.removePipes(pipesTouching(base.pipes, UPGRADE_REMOVED_UNIT_IDS)),
    ...cursor.removeUnits(UPGRADE_REMOVED_UNIT_IDS),
    ...focusRemovalOps(base.viewport?.focus ?? [], UPGRADE_REMOVED_UNIT_IDS),
  ];
  const addBridge = appendOps([], UPGRADE_BRIDGE_PIPES);
  cursor.addPipes(UPGRADE_BRIDGE_PIPES.map((p) => p.id));

  // ---- 第二拍：删掉被取代的直连管 + 加提标单元与绕行管线 ----
  const dropReplaced = cursor.removePipes(UPGRADE_REMOVED_PIPE_IDS);
  const addUpgrade = appendOps(UPGRADE_UNITS, UPGRADE_PIPES);

  return diagramCard(WATER_PROCESS_DSL, {
    intro:
      '这张图现在是初始状态。我演示一下**改图**：厂里要提标改造，' +
      '拆掉初沉池、再上一段臭氧 + 活性炭 + 超滤 —— 动的是同一张图，不是重画一张。',
    beats: [
      {
        text:
          '第一步，拆掉初沉池 —— AAO 前不设初沉池是现代厂的常见做法，' +
          '让更多碳源进生化段供反硝化用。拆它的同时要补一根连通管：' +
          '沉砂池直接进配水井，不然主线就断了。',
        pointAt: 'primary',
        zoom: { direction: 'to', scale: VIEW_UNIT },
        patchState: [...dropPrimary, ...addBridge],
      },
      {
        text:
          '第二步，加提标段：臭氧接触池 → 活性炭滤池 → 膜池（超滤），' +
          '插在滤布滤池和消毒之间；原来那根 `filter → disinfect` 的直连管线被这四根取代了：',
        pointAt: 'filter',
        zoom: { direction: 'to', scale: VIEW_STAGE },
        patchState: [...dropReplaced, ...addUpgrade],
      },
      {
        text:
          '看深度处理那一段多出来的三个池子 —— 这就是提标段。初沉池那一格也空了。' +
          '整个过程**没有重画**：图层是同一块画布、同一个 ICE 实例，视图也没跳。',
        pointAt: 'ozone',
        zoom: { direction: 'to', scale: VIEW_STAGE },
      },
      {
        text:
          '它走的不是新的工具调用，而是 `STATE_DELTA` 里的**标准 JSON Patch**' +
          '（`add /diagram/units/-` 与 `remove /diagram/units/6`）：' +
          '"state 变了"这件事协议里本来就有词，不用再发明一个"图元增删事件"。\n' +
          '前端按**补丁的形状**分流 —— 只往 rows 追加走 `appendData`，只增删图元走增量，' +
          '其余退全量重建。分流规则是纯函数，`tests/state-patch.test.ts` 里穷举过。',
        zoom: { ...VIEW_ALL_FIT },
      },
    ],
  });
}

/**
 * 出水 COD 趋势卡：**锚定到图上的在线监测仪**（`codAnalyzer` / AIT-106）。
 *
 * 卡片浮起来的同时，工艺图上那个单元会被高亮、镜头跟过去 —— 这就是"这张卡片说的是图上哪个东西"。
 * 解说的那一拍指的还是**图表里的那个尖峰**（图表卡上的 `pointAt` 认的是 x 刻度值）。
 */
/** 出水 COD 近 6 日趋势（锚定到图上的在线监测仪 AIT-106）。 */
function codTrendPlan(): ToolCardPlan {
  return chartCard(COD_TREND_DSL, {
    intro:
      '好的，我把出水 COD 在线监测（AIT-106）近 6 日的读数拉出来 —— ' +
      '对照《城镇污水处理厂污染物排放标准》一级A 的限值 50 mg/L 看。',
    anchor: { value: 'codAnalyzer', label: 'AIT-106' },
    beats: [
      { text: '画好了。这六天日均 36 mg/L，离限值还有一段余量，' },
      { text: '不过 9-15 那天冒出一个尖峰（46），一天涨了 8 —— 就是这个点。', pointAt: '9-15' },
    ],
  });
}

/** 流式追加剧本：先画出水计量的前 6 秒，然后一拍一拍往后补数据点（走 appendData 快路径）。 */
function streamingPlan(): ToolCardPlan {
  return chartCard(OUTLET_FLOW_DSL, {
    intro: '先给出水计量井（FIT-101）前 6 秒的实时流量 —— 这座厂日均约 4167 m³/h。',
    anchor: { value: 'meter', label: 'FIT-101' },
    beats: [
      { text: '我接着往前推，第 7 秒上到 4428：', appendRows: [[7, 4428]] },
      { text: '第 8 秒继续涨到 4494：', appendRows: [[8, 4494]] },
      { text: '第 9 秒回落到 4176 了，留意这个拐点：', appendRows: [[9, 4176]] },
    ],
  });
}

/**
 * 自修复剧本。
 *
 * 第一次：故意吐一份列名写错的 DSL —— 客户端 `validateChartDsl` 会拦下来，
 * 把结构化诊断塞进下一轮 run 的 context。
 * 第二次（context 里带诊断）：吐修正版。
 *
 * 脚本化阶段就把这条回路走通，意义在于 M2 接真模型时，回路上的每一段都已经测过了。
 */
function repairPlan(hasDiagnostics: boolean, failedTool?: string): ToolCardPlan {
  // 修复轮必须吐回**同一种**卡片：失败的是图，就修图。
  // 原先这里无条件吐柱状图 —— 图 DSL 写错时 agent 会"修"成一张销量图。
  const isDiagram = failedTool === RENDER_DIAGRAM_TOOL;

  if (!hasDiagnostics) {
    if (isDiagram) {
      return diagramCard(BROKEN_DIAGRAM_DSL, {
        intro: '我先加一个「隔油池」试试 —— 你看看画出来什么样。',
        beats: [{ text: '这一版是故意写错的 —— 用来演示诊断回灌的自修复回路（图这一路）。' }],
      });
    }
    return chartCard(BROKEN_DSL, {
      intro: '我先按「COD浓度」这个列名画一版，你看看。',
      beats: [{ text: '这一版是故意写错的 —— 用来演示诊断回灌的自修复回路。' }],
    });
  }

  if (isDiagram) {
    return diagramCard(WATER_PROCESS_DSL, {
      intro:
        '收到诊断了 —— `ice-entity-designer` 里没有「隔油池」这种符号，' +
        '这套 31 种符号是给排水工艺图的记号集，不含隔油池。去掉它重画：',
      beats: [{ text: '主流程不受影响，还是从进水一路走到排放口。', pointAt: 'inlet' }],
    });
  }
  return chartCard(COD_TREND_DSL, {
    intro: '收到诊断了 —— 表里没有「COD浓度」这一列，可用的是「COD」。改过来了：',
    // 修复轮是**接着上一张卡片的上下文**：锚定要一起带回来，
    // 否则修完之后卡片就"飘"了（图上不再指回那台在线监测仪）。
    anchor: { value: 'codAnalyzer', label: 'AIT-106' },
    beats: [{ text: '还是 9-15 那天最高，46 mg/L，没有破一级A 的 50。', pointAt: '9-15' }],
  });
}

/**
 * **人机回环：中断并要参数。**
 *
 * 事件序列是：说一句 → 流式吐表单 DSL（前端能看到它在拼）→ STATE_SNAPSHOT →
 * 再补一句 → `RUN_FINISHED` **带 `outcome.type === 'interrupt'`**。
 *
 * 注意中断也是 `RUN_FINISHED`（协议如此）——"run 结束了"与"还留着一个待答复的口子"
 * 并不矛盾，前端据此进入 `waiting` 而不是 `idle`。
 */
function confirmPlan(): ToolCardPlan {
  return {
    tool: COLLECT_INPUT_TOOL,
    payload: CONFIRM_FORM_DSL,
    stateKey: STATE_FORM_KEY,
    // 这张表是**对进水泵站 P-101 的操作**，所以锚定到那台泵：
    // 表单浮起来的同时，图上高亮它、镜头跟过去；提交之后还会再闪一下（`anchorFeedback`）。
    anchor: { value: 'inletPump', label: 'P-101' },
    intro: '要给进水泵 P-101 改运行参数，我先跟你确认几项 —— 现在集水井液位 3.4 m，流量 2040 m³/h。',
    beats: [{ text: '填好点「确认下发」，我按这套参数把泵的给定值写下去。' }],
    interrupt: {
      id: 'confirm-params',
      reason: '需要用户确认泵组与运行参数后才能下发',
      message: '请确认泵组、控制方式与目标流量',
    },
  };
}

/**
 * **加药与工艺参数调整单**（表单卡片）。
 *
 * 这一份**故意不做中断** —— 它是一条"直接给你看"的剧本：一次 run 里把表单卡片推出来，
 * 填一遍、提交，`（已提交表单：…）` 会作为下一条消息回到会话里（见 `submittedFormPlan`）。
 * 要看不带这层"提交后回执"的纯中断回路，走「给进水泵下发指令」那条。
 */
function dosingPlan(): ToolCardPlan {
  return {
    tool: COLLECT_INPUT_TOOL,
    payload: DOSING_FORM_DSL,
    stateKey: STATE_FORM_KEY,
    // 锚到 PAC 加药装置：卡片上的数字填的是哪台设备，图上直接圈出来
    anchor: { value: 'pacDosing', label: 'DU-101' },
    intro: '好，我把 PAC 投加调整单拉出来 —— 药剂、投加点、投加量与执行周期都在上面。',
    beats: [
      { text: '图上先圈出 PAC 加药装置 DU-101，数字对着它填。' },
      { text: '填完提交，我按这套参数折算当班加药量与药耗。' },
    ],
  };
}

/**
 * 字段 key → 中文标签。
 *
 * 回执里要念一遍用户填了什么，而协议里带回来的是 `station` / `flow` 这种英文 key ——
 * 直接念 key 在现场看着很怪（"flow：2080"）。这里按单据语义翻译成人话。
 */
const FIELD_LABELS: Record<string, string> = {
  station: '泵组',
  mode: '控制方式',
  flow: '目标流量 (m³/h)',
  level: '集水井目标液位 (m)',
  note: '备注',
  hmiColor: 'HMI 标识色',
  urgency: '紧急程度',
  startAt: '每日起始时刻',
  period: '计划执行周期',
  plant: '厂区 / 工段',
  dosingPoint: '加药点',
  chemical: '药剂',
  dose: '投加量 (L/h)',
  doseRate: '投加浓度 (%)',
  reasons: '调整原因',
  risk: '风险等级',
  devices: '关联设备',
};

function describeValues(values: any): string {
  return Object.entries(values || {})
    .map(([key, value]) => `  · ${FIELD_LABELS[key] || key}：${Array.isArray(value) ? value.join('、') : value}`)
    .join('\n');
}

/** 收到 resume 之后：读用户填的值并应答。 */
function resumedPlan(values: any): ToolCardPlan {
  const pairs = describeValues(values);
  return {
    beats: [
      {
        text:
          '收到确认，按这套参数下发：\n' +
          (pairs || '  （没有带回任何值）') +
          '\n\n' +
          'P-101 的给定值已经写到控制柜；现场把转换开关打到「远程」就能接管。\n' +
          '（这些值是走协议的 `resume` 通道回来的 —— 它不是一次新的提问，' +
          '而是对上一轮那个中断的答复，所以我知道它们对应哪一次下发。）',
      },
    ],
  };
}

/**
 * **表单提交后的回执**（非中断的那张「加药与工艺参数调整单」）。
 *
 * 客户端把提交结果作为一条普通消息发回来：`（已提交表单：key=value, …）`。
 * 这一条把它翻译成业务回执 —— 没有它的话，提交完会掉进兜底剧本，
 * 用户看到的是一排"试试这些"的菜单，像是把自己的单子弄丢了。
 */
function submittedFormPlan(message: string): ToolCardPlan | null {
  const matched = /^（已提交表单：([\s\S]*)）$/.exec(String(message || '').trim());
  if (!matched) return null;
  const values: Record<string, any> = {};
  matched[1]
    .split(', ')
    .filter(Boolean)
    .forEach((pair) => {
      const at = pair.indexOf('=');
      if (at === -1) return;
      const key = pair.slice(0, at);
      const raw = pair.slice(at + 1);
      values[key] = raw.includes('/') ? raw.split('/') : raw;
    });

  const dose = Number(values.dose);
  const perShift = Number.isFinite(dose) && dose > 0 ? `\n按 ${dose} L/h 折算，每班（8h）约 ${Math.round(dose * 8)} L。` : '';
  return {
    beats: [
      {
        text:
          '收到这张调整单了：\n' +
          (describeValues(values) || '  （单据是空的）') +
          perShift +
          '\n\n我先挂在「待复核」上，值班长确认后再下发到加药间；执行周期内我每天按当班化验值核一次效果。',
      },
    ],
  };
}

/** 兜底：不画图，只回文字。 */
function textOnlyPlan(message: string): ToolCardPlan {
  return {
    beats: [
      {
        text:
          `我还没接模型，现在只能按关键词走固定剧本。\n` +
          `你刚才说的是「${message}」。\n\n` +
          // 分组与顺序**对齐输入框上方那排按钮**（见 `src/entries/boot.ts` 的
          // `CHIP_GROUPS`）—— 两处不一致的话，这段话就变成了在指路指错。
          `试试这些：\n\n` +
          `  【工艺图】这张图开页就在，下面这些都作用在它上面：\n` +
          `  · 看看污水处理工艺图（完整走查一遍，镜头跟着讲解推近 + 高亮）\n` +
          `  · 把工艺图放大（让 AI 下命令缩放视图）\n` +
          `  · 让图元闪烁（让 AI 下命令高亮闪烁）\n` +
          `  · 提标改造（让 AI **改图**：拆掉初沉池、加三个提标单元，画面不重画）\n` +
          `  · 故意画错工艺图（诊断回灌的自修复回路，**图**这一路）\n\n` +
          `  【其他】\n` +
          `  · 看看出水 COD 的趋势（锚定到图上的出水 COD 在线监测 AIT-106）\n` +
          `  · 看看出水实时流量（出水计量井 FIT-101 的秒级流量）\n` +
          `  · 给进水泵下发指令（走一遍中断 → 填表 → resume 的人机回环，锚定到进水泵 P-101）\n` +
          `  · 调整加药量（开一张加药与工艺参数调整单）\n` +
          `  · 故意画错（同一条自修复回路，但走**图表**那一路）\n` +
          `  · 出水要达到什么标准（兜底：只回文字、不动图）`,
      },
    ],
  };
}

/**
 * 用户在图上/控件条上做了动作。
 *
 * 三种来源走同一条 `context` 通道，靠 `kind` 区分：
 * - `item-click` / `brush`：来自**图表**那张画布
 * - `widget-action`：来自**控件条**那张画布（`ice-web-components` 画的按钮）
 */
function interactionPlan(interaction: string, currentChart: any): ToolCardPlan | null {
  let parsed: any = null;
  try {
    parsed = JSON.parse(interaction);
  } catch {
    return null;
  }

  if (parsed?.kind === 'widget-action') {
    switch (parsed.action) {
      case 'explain':
        return explainPlan(currentChart);
      case 'redraw':
        return redrawPlan(currentChart);
      case 'stream':
        return streamingPlan();
      default:
        return { beats: [{ text: `控件「${parsed.action}」我还没接上。` }] };
    }
  }

  if (parsed?.kind === 'item-click') {
    const value = parsed.value === undefined ? '' : `，值 ${parsed.value}`;
    return {
      beats: [
        {
          text:
            `你点了「${parsed.xValue}」${value}` +
            (parsed.seriesName ? `（${parsed.seriesName}）` : '') +
            `。\n` +
            `要归因的话，我会把这一天的进水水质、加药量与回流比一起调出来对一遍 —— ` +
            `点进来的这一刻我拿到的就是你**在图上指的那个点**。\n` +
            `（这个交互是走 AG-UI 的 \`context\` 字段送上来的，不是拼在你说的话里，` +
            `所以我能分清哪部分是"你指的"、哪部分是"你说的"。）`,
        },
      ],
    };
  }

  if (parsed?.kind === 'brush') {
    const span = parsed?.range?.x ? `${parsed.range.x[0]} ~ ${parsed.range.x[1]}` : '一段区间';
    const inside = (currentChart?.data?.rows || []).filter(
      (row: any) => Array.isArray(row) && row[0] >= parsed?.range?.x?.[0] && row[0] <= parsed?.range?.x?.[1]
    );
    const values = inside.map((row: any) => Number(row[1])).filter((n: number) => Number.isFinite(n));
    const average = values.length ? (values.reduce((a: number, b: number) => a + b, 0) / values.length).toFixed(1) : '';
    return {
      beats: [
        {
          text:
            `你框选了 ${span}。\n` +
            (values.length ? `这一段 ${values.length} 个采样，均值 ${average}，最高 ${Math.max(...values)}。\n` : '') +
            `接下来我会按这一段去查同期的进水冲击与加药记录，看看是水量变化还是药剂投加引起的。\n` +
            `（框选范围和点位一样，是走 context 上来的结构化数据。）`,
        },
      ],
    };
  }

  return null;
}

/** 「解释这张图」：**读 state** 里客户端回传的图表定义，逐项说出来。 */
function explainPlan(current: any): ToolCardPlan {
  if (!current) {
    return { beats: [{ text: '绘图区现在还没有图 —— 先让我画一张，再来解释。' }] };
  }
  const enc = current.encoding || {};
  const rawRows: any[] = Array.isArray(current.data?.rows) ? current.data.rows : [];
  const yIndex = Array.isArray(current.data?.columns) ? current.data.columns.indexOf(enc.y) : -1;
  const values = rawRows
    .map((row) => Number(Array.isArray(row) ? row[yIndex === -1 ? 1 : yIndex] : row?.[enc.y]))
    .filter((n) => Number.isFinite(n));
  const columns = Array.isArray(current.data?.columns) ? current.data.columns.join(' / ') : '(未声明)';
  const channels = [`x=${enc.x}`];
  if (enc.y) channels.push(`y=${enc.y}`);
  if (enc.series) channels.push(`分组=${enc.series}`);

  const average = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const peak = values.length ? Math.max(...values) : null;
  const peakRow = peak === null ? null : rawRows.find((row) => Number(row[yIndex === -1 ? 1 : yIndex]) === peak);

  return {
    beats: [
      {
        text:
          `这张是「${current.title || columns}」（${current.kind}），共 ${rawRows.length} 个点` +
          (average !== null ? `，均值 ${average.toFixed(1)}` : '') +
          (peak !== null ? `，最高 ${peak}${peakRow ? `（${peakRow[0]}）` : ''}` : '') +
          `。\n` +
          `看的是 ${enc.y || columns}${enc.x ? ` 随 ${enc.x}` : ''} 的变化${enc.series ? `，按 ${enc.series} 分组` : ''}。\n` +
          (enc.y && String(enc.y).includes('COD') && peak !== null
            ? `对照一级A 的限值 50 mg/L：最高 ${peak}，余量 ${50 - peak} 个点 —— ` +
              `值得盯的是峰值那天，通常先查进水冲击，再查加药与回流比。\n`
            : '') +
          `（图的内容我是从画布状态里读出来的 —— 通过 AG-UI 的 state 字段同步，不是靠猜。）`,
      },
    ],
  };
}

/**
 * 「换个画法」：**读 state** 拿到当前图表，只换呈现方式、数据不动 —— 对照组。
 *
 * 这是最能说明 `state` 用途的例子：agent 不需要你复述"刚才画的是什么"。
 */
function redrawPlan(current: any): ToolCardPlan {
  if (!current) return codTrendPlan();

  const nextKind = current.kind === 'line' ? 'bar' : 'line';
  const label = nextKind === 'line' ? '折线' : '柱状';
  return chartCard(
    { ...current, kind: nextKind, title: `${current.title || '图表'}（改成${label}图）` },
    {
      intro: `好，同一份数据换成${label}图重画一版。`,
      beats: [{ text: `数据一行没动，只换了呈现方式 —— 你看到的差异全部来自图表类型本身。` }],
    }
  );
}

/**
 * 剧本选择的一次输入。
 *
 * 用选项对象而不是一串位置参数：这里已经有五样东西了（消息、诊断、交互、状态、resume），
 * 位置参数会让调用点变成 `buildPlan('x', false, null, state, resume)` 这种没人读得懂的东西。
 */
export interface PlanInput {
  /** 用户最后一句发言。 */
  message: string;
  /** 上一轮渲染端回灌的诊断（非空即"在修复轮里"）。 */
  hasDiagnostics: boolean;
  /**
   * 上一轮**失败的是哪个工具**（`ice-dsl-tool` context）。
   *
   * 只影响修复轮吐回哪种卡片：不知道的话就只能猜 ——
   * 而"图 DSL 写错了，于是给你重画一张柱状图"是这个猜测最糟的结果。
   * 缺省（老客户端不发这条）按图表卡处理，行为与加这条之前一致。
   */
  diagnosticsTool?: string | null;
  /** 用户在图上/控件条上做动作的 JSON 串。 */
  interaction?: string | null;
  /** AG-UI 的共享状态。客户端把"现在画面上是什么"放在这里。 */
  state?: any;
  /** 对上一轮中断的答复（协议原生通道）。 */
  resume?: any[] | null;
}

/** 从 resume 里取出用户填的值。服务端只关心第一个（M1 一次只有一个中断）。 */
export function resumeValues(resume: any[] | null | undefined): any | null {
  const first = Array.isArray(resume) ? resume[0] : null;
  if (!first) return null;
  if (first.status === 'cancelled') return null;
  return first.payload ?? {};
}

/**
 * 剧本选择。规则很土，但**必须是确定性的**——e2e 和单测都靠它。
 */
export function buildPlan(input: PlanInput): ToolCardPlan {
  const text = (input.message || '').trim();

  // 收到了对中断的答复：优先于其他一切 —— 这正是"接着上一轮往下走"
  const resumed = resumeValues(input.resume);
  if (resumed !== null) return resumedPlan(resumed);

  // 非中断那张表单（加药调整单）提交后，客户端会把值拼成一条消息发回来 —— 先给出回执，
  // 否则它会掉进下面的关键词匹配、最后落到兜底剧本（看起来像把用户的单子弄丢了）。
  const submitted = submittedFormPlan(text);
  if (submitted) return submitted;

  // 已经在修复轮里：不管用户说了什么，都按修复走（但要吐回**同一种**卡片）
  if (input.hasDiagnostics) return repairPlan(true, input.diagnosticsTool ?? undefined);

  // 用户在图上做了动作：优先应答这件事，因为它比关键词更能说明意图
  if (input.interaction) {
    const plan = interactionPlan(input.interaction, input.state?.chart);
    if (plan) return plan;
  }

  if (/故意|画错|写错|坏|诊断|修复/.test(text)) {
    // "故意画错"要**配合内容**才知道画错哪种图
    return repairPlan(false, isWaterAsk(text) ? RENDER_DIAGRAM_TOOL : undefined);
  }
  if (/下发|确认参数|填表|参数确认|中断/.test(text)) return confirmPlan();
  if (/加药|投加|药耗|药剂|调整单/.test(text)) return dosingPlan();
  // ⚠️ 水务这条必须排在「实时|趋势|流」之前：「工艺流程」里含「流」，
  // 排在后面的话问工艺图会被流式剧本抢走（这个坑踩过一次）
  // ⚠️ 缩放 / 闪烁这两条必须排在 `isWaterAsk` **之前**：
  // 「把工艺图放大」里既有"工艺图"也有"放大"，而这一句的意图是**缩放**不是重新画图。
  // 排在后面的话会被 waterProcessPlan 抢走，用户看到的是一张重画的图而不是放大的图。
  // 顺序上这两条也不用再判 isWaterAsk —— 它们是图卡专用的命令（图表卡会静默忽略）。
  if (/放大|缩小|缩放|复位|推近|拉远/.test(text)) return zoomPlan();
  if (/闪烁|闪一下|闪两下|闪一闪|闪烁一下/.test(text)) return blinkPlan();
  // ⚠️ 「提标 / 改造」也要排在 `isWaterAsk` **之前** —— 这一句里同样含"工艺图"，
  // 而它的意图是**改图**（增删图元），不是"再看看那张图"。
  // 判断得**在 `故意画错` 之后**（那一条更具体，且优先级更高）。
  if (/提标|改造|拆掉|拆除|改图|增删|加三个|加几个|新增图元|删掉/.test(text)) return upgradePlan();
  if (isWaterAsk(text)) return waterProcessPlan();
  // ⚠️ 这条必须排在「实时|趋势|流」**之前**：新图表的说法里带"趋势"，
  // 排在后面的话会被流式剧本抢走（图表变成一条实时曲线）。
  if (/COD|氨氮|水质|指标|排放/.test(text)) return codTrendPlan();
  if (/实时|趋势|流|追加|访问量|吞吐/.test(text)) return streamingPlan();
  // 兜底：老说法（"各渠道的月度销量"）仍然指向同一张 COD 趋势卡 ——
  // 关键词表可以随题材演进，但**不该让旧话变成"听不懂"**。
  if (/销量|渠道|柱|趋势图/.test(text)) return codTrendPlan();

  return textOnlyPlan(text);
}

/** 暴露给测试：几个 DSL 常量。 */
export const SCENARIO_DSL = {
  /** 出水 COD 趋势（锚定到图上的在线监测仪 AIT-106）—— 原名 `SALES_DSL`，题材改成水务的了。 */
  SALES_DSL: COD_TREND_DSL,
  BROKEN_DSL,
  OUTLET_FLOW_DSL,
  CONFIRM_FORM_DSL,
  DOSING_FORM_DSL,
  WATER_PROCESS_DSL,
  BROKEN_DIAGRAM_DSL,
};
