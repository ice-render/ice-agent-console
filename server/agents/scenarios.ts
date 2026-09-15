/**
 * 剧本：把用户一句话映射成一份"图表计划"。
 *
 * **这是 M2 会被替换掉的那一层。** 现在它是几个 if-else，将来这里会是一次模型调用，
 * 但产出的 `ChartPlan` 形状不变——所以它下面的一切（事件序列、前端归约、ICE 渲染）都不用动。
 *
 * 之所以把它单独放一个文件而不是塞进 scripted.ts：等 M2 加 `llm.ts` 的时候，
 * 两个实现摆在一起，接口一致这件事一眼就能看出来。
 */
import type { ChartPlan } from './dsl-to-events';

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

/** 默认剧本：柱状图 + 画完之后指着 3 月讲。 */
function salesPlan(): ChartPlan {
  return {
    dsl: SALES_DSL,
    intro: '好的，我拉一下各渠道的月度销量，用分组柱状图看。',
    beats: [
      { text: '画好了。整体看线上一直压着线下，' },
      { text: '不过 3 月线上有个明显的尖峰 —— 就是这个点。', pointAt: '3月' },
    ],
  };
}

/** 流式追加剧本：先画前 6 秒，然后一拍一拍往后补数据点（走 appendData 快路径）。 */
function streamingPlan(): ChartPlan {
  return {
    dsl: TRAFFIC_DSL,
    intro: '先给你前 6 秒的吞吐量。',
    beats: [
      { text: '我接着往前推，第 7 秒上来了：', appendRows: [[7, 171]] },
      { text: '第 8 秒继续涨：', appendRows: [[8, 188]] },
      { text: '第 9 秒开始回落了，留意这个拐点：', appendRows: [[9, 154]] },
    ],
  };
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
function repairPlan(hasDiagnostics: boolean): ChartPlan {
  if (!hasDiagnostics) {
    return {
      dsl: BROKEN_DSL,
      intro: '我先按「销售额」这个列名画一版，你看看。',
      beats: [{ text: '这一版是故意写错的 —— 用来演示诊断回灌的自修复回路。' }],
    };
  }
  return {
    dsl: SALES_DSL,
    intro: '收到诊断了 —— 表里没有「销售额」这一列，可用的是「销量」。改过来了：',
    beats: [{ text: '还是 3 月线上最高的那个形态。', pointAt: '3月' }],
  };
}

/** 兜底：不画图，只回文字。 */
function textOnlyPlan(message: string): ChartPlan {
  return {
    beats: [
      {
        text:
          `我还没接模型，现在只能按关键词走固定剧本。\n` +
          `你刚才说的是「${message}」。\n\n` +
          `试试这些：\n` +
          `  · 看看各渠道的月度销量\n` +
          `  · 看一下实时吞吐量\n` +
          `  · 故意画错（走一遍诊断回灌的自修复回路）`,
      },
    ],
  };
}

/**
 * 用户在图上做了动作（点了数据点 / 框选了一段）。
 *
 * 这个剧本的意义不在于回答得多好，而在于**证明上行通道真的通了**：
 * 应用把结构化交互塞进 `context`，agent 读到了它，并且能说出来。
 *
 * 这一条到了 M2 会变成真正的追问——"为什么 3 月线上最高"要模型结合数据回答。
 * 但通道本身现在就该是通的，否则接模型时会分不清"是模型不会答，还是上下文没送到"。
 */
function interactionReplyPlan(interaction: string): ChartPlan {
  let parsed: any = null;
  try {
    parsed = JSON.parse(interaction);
  } catch {
    parsed = null;
  }

  let text = '我收到了你在图上的操作。';
  if (parsed?.kind === 'item-click') {
    text =
      `你在图上点了「${parsed.xValue}」` +
      (parsed.seriesName ? `（${parsed.seriesName}系列，值 ${parsed.value}）` : '') +
      `。\n` +
      `这个交互是通过 AG-UI 的 context 字段送上来的，不是拼在你说的话里——` +
      `所以我知道哪部分是"你做的"、哪部分是"你说的"。\n` +
      `接上模型之后，这里就会变成一次真正的追问。`;
  } else if (parsed?.kind === 'brush') {
    const span = parsed?.range?.x ? `${parsed.range.x[0]} ~ ${parsed.range.x[1]}` : '一段区间';
    text =
      `你框选了 ${span}。\n` +
      `框选范围同样是走 context 上来的结构化数据，` +
      `接上模型之后就能针对这一段做归因。`;
  }

  return { beats: [{ text }] };
}

/**
 * 剧本选择。规则很土，但**必须是确定性的**——e2e 和单测都靠它。
 *
 * `interaction` 是用户在图上做动作的 JSON 串（由应用塞进 context 送上来）。
 */
export function buildPlan(
  message: string,
  hasDiagnostics: boolean,
  interaction?: string | null
): ChartPlan {
  const text = (message || '').trim();

  // 已经在修复轮里：不管用户说了什么，都按修复走
  if (hasDiagnostics) return repairPlan(true);

  // 用户在图上做了动作：优先应答这件事，因为它比关键词更能说明意图
  if (interaction) return interactionReplyPlan(interaction);

  if (/故意|画错|写错|坏|诊断|修复/.test(text)) return repairPlan(false);
  if (/实时|趋势|流|追加|访问量|吞吐/.test(text)) return streamingPlan();
  if (/销量|渠道|柱|卖/.test(text)) return salesPlan();

  return textOnlyPlan(text);
}
