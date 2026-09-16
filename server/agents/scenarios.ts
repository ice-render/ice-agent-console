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

/** 一张表 + encoding，这就是 ice-chart-dsl 想要的形态。 */
const SALES_DSL = {
  schemaVersion: 1,
  kind: 'bar',
  title: '各渠道月度销量',
  data: {
    columns: ['月份', '销量', '渠道'],
    rows: [
      ['1月', 120, '线上'],
      ['1月', 86, '线下'],
      ['2月', 96, '线下'],
      ['2月', 132, '线上'],
      ['3月', 168, '线上'],
      ['3月', 101, '线下'],
      ['4月', 142, '线上'],
      ['4月', 88, '线下'],
      ['5月', 133, '线上'],
      ['5月', 95, '线下'],
      ['6月', 118, '线上'],
      ['6月', 90, '线下'],
    ],
  },
  encoding: { x: '月份', y: '销量', series: '渠道' },
};

/** 故意写错的一版：`销售额` 不是表里的列。用来走自修复回路。 */
const BROKEN_DSL = {
  ...SALES_DSL,
  title: '各渠道月度销量（第一版，写错了列名）',
  encoding: { x: '月份', y: '销售额', series: '渠道' },
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
 * 实时流剧本的数据源。
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
const TRAFFIC_DSL = {
  schemaVersion: 1,
  kind: 'line',
  title: '实时吞吐量',
  data: {
    columns: ['秒', '吞吐'],
    rows: [
      [1, 92],
      [2, 105],
      [3, 148],
      [4, 136],
      [5, 151],
      [6, 163],
    ],
  },
  encoding: { x: '秒', y: '吞吐' },
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
  title: '下发前确认',
  description: '这三项确认后才会把控制指令发下去。',
  fields: [
    {
      name: 'station',
      type: 'select',
      label: '泵站',
      required: true,
      options: [
        { value: 'pump-1', label: '一号泵站' },
        { value: 'pump-2', label: '二号泵站' },
      ],
    },
    {
      name: 'mode',
      type: 'radio-group',
      label: '运行模式',
      default: 'auto',
      options: [
        { value: 'auto', label: '自动' },
        { value: 'manual', label: '手动' },
      ],
    },
    {
      name: 'flow',
      type: 'number',
      label: '目标流量 (m³/h)',
      required: true,
      min: 0,
      max: 5000,
      step: 10,
      default: 800,
    },
    { name: 'note', type: 'textarea', label: '备注', maxLength: 120, placeholder: '选填' },
  ],
  submitText: '确认下发',
};

/**
 * **第二批控件的演示表单。**
 *
 * 0.3.0 起 `ice-web-components-dsl` 的字段类型从 11 个扩到 20 个，这张表把新接的 9 个
 * 各放一个，加上一个多选 `select`（它顺便证明了"数组默认值"那个 bug 已经修好）。
 *
 * 全部 10 个字段都**没有写宽度** —— 那是宿主 + DSL 的事（见该包 README §8.1）。
 * `options` 也一律用**裸字符串**写法（除了需要 label 的），因为不同控件对选项形状的
 * 要求不一样（`colors: string[]` / `options: string[]` / `nodes: {key,label}` /
 * `dataSource`），那些差别由编译期归一化 —— agent 不该知道。
 */
const SHOWCASE_FORM_DSL = {
  schemaVersion: 1,
  kind: 'form',
  title: '第二批控件',
  description: '0.3.0 新接的 9 个字段类型，各来一个。',
  fields: [
    {
      name: 'themeColor',
      type: 'color',
      label: '主题色',
      default: '#61D9FB',
      options: ['#61D9FB', '#0F172A', '#16A34A', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6'],
    },
    {
      name: 'priority',
      type: 'segmented',
      label: '优先级',
      default: 'normal',
      options: [
        { value: 'low', label: '低' },
        { value: 'normal', label: '中' },
        { value: 'high', label: '高' },
      ],
    },
    { name: 'triggerAt', type: 'time', label: '触发时间', format: 'HH:mm', default: '08:30' },
    {
      name: 'window',
      type: 'date-range',
      label: '维护窗口',
      required: true,
      default: ['2026-09-01', '2026-09-07'],
    },
    {
      name: 'region',
      type: 'cascader',
      label: '区域',
      placeholder: '选省 / 市',
      separator: ' / ',
      options: [
        { value: 'zj', label: '浙江', children: [{ value: 'hz', label: '杭州' }, { value: 'nb', label: '宁波' }] },
        { value: 'js', label: '江苏', children: [{ value: 'nj', label: '南京' }, { value: 'sz', label: '苏州' }] },
      ],
    },
    {
      name: 'station',
      type: 'tree-select',
      label: '泵站',
      placeholder: '按分组选',
      showSearch: true,
      options: [
        { value: 'group-a', label: 'A 组', children: [{ value: 'pump-1', label: '一号泵站' }, { value: 'pump-2', label: '二号泵站' }] },
        { value: 'group-b', label: 'B 组', children: [{ value: 'pump-3', label: '三号泵站' }] },
      ],
    },
    {
      name: 'tags',
      type: 'transfer',
      label: '标签',
      default: ['例检'],
      options: ['例检', '抢修', '节能', '扩容', '试运行'],
    },
    { name: 'risk', type: 'rate', label: '风险等级', max: 5, default: 3 },
    {
      name: 'keyword',
      type: 'autocomplete',
      label: '关键词',
      placeholder: '输入以筛选',
      options: ['泵站', '阀门', '管道', '变频器', '液位计', '流量计'],
    },
    {
      name: 'devices',
      type: 'select',
      mode: 'multiple',
      label: '关联设备',
      default: ['V-101'],
      options: ['V-101', 'V-102', 'P-201', 'P-202'],
    },
  ],
  submitText: '提交看看',
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
 * 讲解用的三档倍率。
 *
 * 为什么是**绝对**倍率而不是"放大一档"：一条十几拍的解说里叠三次相对缩放，
 * 倍率就飘到不可预期；而写死档位之后，讲稿的任何一拍停在哪一屏都是确定的
 * —— 单测与 e2e 也才断言得了。
 *
 * | 档 | 倍率 | 用在哪 | 一屏能看到 |
 * |---|---|---|---|
 * | 全貌 | 0.22 | 开场 / 收尾：整张图纸（含污泥线、事故水、加药间） | 约 4800 世界像素宽 = 整张图 |
 * | 分段 | 0.85 | 讲一条工艺段（预处理 / 生化 / 深度处理） | 约 1200 = 4~5 个池子 |
 * | 单格 | 1.5 | 讲一个池子：位号、名称、进出管线都读得清 | 约 700 = 1~2 个池子 |
 *
 * 三个数与 `WATER_PROCESS_DSL` 的世界尺寸（约 4900×2400）配着调 ——
 * 改动坐标之后**回来重算一遍**，否则"全貌"那档会装不下整张图
 * （0.42 是上一版 1900 宽时的数，铺开之后那个倍率只看得到主流程的一半）。
 */
const VIEW_ALL = 0.22;
const VIEW_STAGE = 0.85;
const VIEW_UNIT = 1.5;

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
 * 1. 先 `to: VIEW_ALL` 把整张图收进视野（开页那一屏是按 focus 取的近景，看不到污泥线）；
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
function waterProcessPlan(): ToolCardPlan {
  return diagramCard(WATER_PROCESS_DSL, {
    intro:
      '这是某 10 万 m³/d 市政污水厂的全流程：AAO + 混凝沉淀 + 滤布滤池 + 消毒。' +
      '34 个单元、37 段管线，用满了 31 种工艺符号与 9 种介质线型。我按工艺段走一遍，镜头会跟着推近。',
    beats: [
      {
        text:
          '先把整张图框进来 —— 上面那条是水线主线，中间一条是深度处理，' +
          '最下面是污泥线，右边还有一条事故水支路。',
        zoom: { direction: 'to', scale: VIEW_ALL },
      },
      {
        text: '从最左边开始。厂外进水进来先加压，出口接止回阀、再进细格栅挡大颗粒：',
        pointAt: 'inlet',
        zoom: { direction: 'to', scale: VIEW_UNIT },
      },
      {
        text:
          '接着是曝气沉砂池去掉砂粒，再到初沉池把悬浮物沉下去 —— ' +
          '这两格是预处理段的主体：',
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
        text: '深度处理段从左到右：加药 → 混凝沉淀 → 滤布滤池 → 消毒接触池，除磷、控 SS、杀菌：',
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
          '脱水机房的臭气由除臭装置抽走：',
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
          '世界尺寸约 1900×1800，是拖着看而不是缩略图。',
        zoom: { direction: 'to', scale: VIEW_ALL },
      },
    ],
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
      { text: '先推到全貌，看看整张图纸的骨架：', zoom: { direction: 'to', scale: VIEW_ALL } },
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
        zoom: { direction: 'to', scale: VIEW_ALL },
      },
    ],
  });
}

function salesPlan(): ToolCardPlan {
  return chartCard(SALES_DSL, {
    intro: '好的，我拉一下各渠道的月度销量，用分组柱状图看。',
    beats: [
      { text: '画好了。整体看线上一直压着线下，' },
      { text: '不过 3 月线上有个明显的尖峰 —— 就是这个点。', pointAt: '3月' },
    ],
  });
}

/** 流式追加剧本：先画前 6 秒，然后一拍一拍往后补数据点（走 appendData 快路径）。 */
function streamingPlan(): ToolCardPlan {
  return chartCard(TRAFFIC_DSL, {
    intro: '先给你前 6 秒的吞吐量。',
    beats: [
      { text: '我接着往前推，第 7 秒上来了：', appendRows: [[7, 171]] },
      { text: '第 8 秒继续涨：', appendRows: [[8, 188]] },
      { text: '第 9 秒开始回落了，留意这个拐点：', appendRows: [[9, 154]] },
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
      intro: '我先按「销售额」这个列名画一版，你看看。',
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
  return chartCard(SALES_DSL, {
    intro: '收到诊断了 —— 表里没有「销售额」这一列，可用的是「销量」。改过来了：',
    beats: [{ text: '还是 3 月线上最高的那个形态。', pointAt: '3月' }],
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
    intro: '要下发控制指令，我得先跟你确认几项。',
    beats: [{ text: '填好点「确认下发」，我拿到参数就继续。' }],
    interrupt: {
      id: 'confirm-params',
      reason: '需要用户确认泵站与运行参数后才能下发',
      message: '请确认泵站、运行模式与目标流量',
    },
  };
}

/**
 * 第二批控件的演示。
 *
 * 这一份**故意不做中断** —— 它是一条"直接给你看"的剧本：一次 run 里把表单卡片推出来，
 * 你在浏览器里点一遍就完成它的使命了。要看人机回环走「要下发指令」那条。
 */
function showcasePlan(): ToolCardPlan {
  return {
    tool: COLLECT_INPUT_TOOL,
    payload: SHOWCASE_FORM_DSL,
    stateKey: STATE_FORM_KEY,
    intro: '这是 0.3.0 新接的 9 个字段类型，我在一张表单里各放了一个。',
    beats: [
      { text: '从上往下：颜色、分段、时间、区间、级联、树选择、穿梭框、评分、自动完成。' },
      { text: '点一遍看看哪些顺手、哪些别扭 —— 这一版的目的是让你能判断后面接什么。' },
    ],
  };
}

/** 收到 resume 之后：读用户填的值并应答。 */
function resumedPlan(values: any): ToolCardPlan {
  const pairs = Object.entries(values || {})
    .map(([key, value]) => `  · ${key}：${Array.isArray(value) ? value.join('、') : value}`)
    .join('\n');
  return {
    beats: [
      {
        text:
          '收到你的确认了：\n' +
          (pairs || '  （没有带回任何值）') +
          '\n\n' +
          '这些值是走协议的 `resume` 通道回来的 —— 它不是一次新的提问，' +
          '而是对上一轮那个中断的**答复**。所以我能确定它们对应的是哪一次中断。\n' +
          '接上模型之后，这里就会是一次真正的"拿到参数 → 继续干活"。',
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
          `试试这些：\n` +
          `  · 看看污水处理工艺图（ice-entity-designer 画的工艺流程图，可缩放平移）\n` +
          `  · 看看各渠道的月度销量\n` +
          `  · 看一下实时吞吐量\n` +
          `  · 要下发指令（走一遍中断 → 填表 → resume 的人机回环）\n` +
          `  · 故意画错（走一遍诊断回灌的自修复回路）\n` +
          `  · 把工艺图放大（让 AI 下命令缩放视图）\n` +
          `  · 让图元闪烁（让 AI 下命令高亮闪烁）\n` +
          `  · 提标改造（让 AI **改图**：拆掉初沉池、加三个提标单元）`,
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
    return {
      beats: [
        {
          text:
            `你在图上点了「${parsed.xValue}」` +
            (parsed.seriesName ? `（${parsed.seriesName}系列，值 ${parsed.value}）` : '') +
            `。\n` +
            `这个交互是通过 AG-UI 的 context 字段送上来的，不是拼在你说的话里——` +
            `所以我知道哪部分是"你做的"、哪部分是"你说的"。\n` +
            `接上模型之后，这里就会变成一次真正的追问。`,
        },
      ],
    };
  }

  if (parsed?.kind === 'brush') {
    const span = parsed?.range?.x ? `${parsed.range.x[0]} ~ ${parsed.range.x[1]}` : '一段区间';
    return {
      beats: [
        {
          text:
            `你框选了 ${span}。\n` +
            `框选范围同样是走 context 上来的结构化数据，` +
            `接上模型之后就能针对这一段做归因。`,
        },
      ],
    };
  }

  return null;
}

/** 「解释这张图」：**读 state** 里客户端回传的图表定义，逐项说出来。 */
function explainPlan(current: any): ToolCardPlan {
  if (!current) {
    return { beats: [{ text: '卡片上现在还没有图 —— 先让我画一张，再来解释。' }] };
  }
  const enc = current.encoding || {};
  const rows = Array.isArray(current.data?.rows) ? current.data.rows.length : 0;
  const columns = Array.isArray(current.data?.columns) ? current.data.columns.join(' / ') : '(未声明)';
  const channels = [`x=${enc.x}`];
  if (enc.y) channels.push(`y=${enc.y}`);
  if (enc.series) channels.push(`分组=${enc.series}`);

  return {
    beats: [
      {
        text:
          `这张图的定义我读到了 —— 它是通过 AG-UI 的 state 字段同步给我的，` +
          `不是靠猜：\n` +
          `  · 类型：${current.kind}\n` +
          `  · 标题：${current.title || '(无)'}\n` +
          `  · 列：${columns}\n` +
          `  · 行数：${rows}\n` +
          `  · 编码：${channels.join('，')}\n\n` +
          `接上模型之后，这里会是结合数据的一次真正解释。`,
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
  if (!current) return salesPlan();

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
  if (/控件|组件|演示|第二批|字段类型|都能用/.test(text)) return showcasePlan();
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
  if (/实时|趋势|流|追加|访问量|吞吐/.test(text)) return streamingPlan();
  if (/销量|渠道|柱|卖/.test(text)) return salesPlan();

  return textOnlyPlan(text);
}

/** 暴露给测试：几个 DSL 常量。 */
export const SCENARIO_DSL = {
  SALES_DSL,
  BROKEN_DSL,
  TRAFFIC_DSL,
  CONFIRM_FORM_DSL,
  SHOWCASE_FORM_DSL,
  WATER_PROCESS_DSL,
  BROKEN_DIAGRAM_DSL,
};
