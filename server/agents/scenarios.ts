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
 * 用户在图上/控件条上做了动作。
 *
 * 三种来源走同一条 `context` 通道，靠 `kind` 区分：
 * - `item-click` / `brush`：来自**图表**那张画布
 * - `widget-action`：来自**控件条**那张画布（`ice-web-components` 画的按钮）
 *
 * 后者的意义在于证明"第二块画布也是活的、能参与协议回路"。
 *
 * 其中 `explain` 与 `redraw` 会去读 `input.state.chart` —— 也就是 AG-UI 的 `state` 字段
 * 把**客户端当前的图表定义**同步回 agent。这是本工程第一次用上这个字段：
 * 单向的 context 只能告诉 agent"用户做了什么"，state 才能告诉它"现在画面上是什么"。
 */
function interactionPlan(interaction: string, currentChart: any): ChartPlan | null {
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
function explainPlan(current: any): ChartPlan {
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
function redrawPlan(current: any): ChartPlan {
  if (!current) return salesPlan();

  const nextKind = current.kind === 'line' ? 'bar' : 'line';
  const label = nextKind === 'line' ? '折线' : '柱状';
  return {
    dsl: {
      ...current,
      kind: nextKind,
      title: `${current.title || '图表'}（改成${label}图）`,
    },
    intro: `好，同一份数据换成${label}图重画一版。`,
    beats: [{ text: `数据一行没动，只换了呈现方式 —— 你看到的差异全部来自图表类型本身。` }],
  };
}

/**
 * 剧本选择。规则很土，但**必须是确定性的**——e2e 和单测都靠它。
 *
 * @param interaction 用户在图上/控件条上做动作的 JSON 串（应用塞进 context 送上来）
 * @param state       AG-UI 的共享状态。客户端把**当前图表定义**放在 `state.chart` 里，
 *                    所以 agent 能读到"现在画面上是什么"，不必让用户复述
 */
export function buildPlan(
  message: string,
  hasDiagnostics: boolean,
  interaction?: string | null,
  state?: any
): ChartPlan {
  const text = (message || '').trim();

  // 已经在修复轮里：不管用户说了什么，都按修复走
  if (hasDiagnostics) return repairPlan(true);

  // 用户在图上做了动作：优先应答这件事，因为它比关键词更能说明意图
  if (interaction) {
    const plan = interactionPlan(interaction, state?.chart);
    if (plan) return plan;
  }

  if (/故意|画错|写错|坏|诊断|修复/.test(text)) return repairPlan(false);
  if (/实时|趋势|流|追加|访问量|吞吐/.test(text)) return streamingPlan();
  if (/销量|渠道|柱|卖/.test(text)) return salesPlan();

  return textOnlyPlan(text);
}
