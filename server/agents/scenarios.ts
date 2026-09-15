/**
 * 剧本：把用户一句话（以及上下文）映射成一份"工具卡计划"。
 *
 * **这是 M2 会被替换掉的那一层。** 现在它是几个 if-else，将来这里会是一次模型调用，
 * 但产出的 `ToolCardPlan` 形状不变——所以它下面的一切都不用动。
 *
 * 之所以单独放一个文件而不是塞进 scripted.ts：等 M2 加 `llm.ts` 的时候，
 * 两个实现摆在一起，接口一致这件事一眼就能看出来。
 */
import { COLLECT_INPUT_TOOL, RENDER_CHART_TOOL, STATE_CHART_KEY, STATE_FORM_KEY } from '../../shared/contract';
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

/** 图表卡的公共部分。 */
function chartCard(payload: unknown, rest: Omit<ToolCardPlan, 'tool' | 'payload' | 'stateKey'>): ToolCardPlan {
  return { tool: RENDER_CHART_TOOL, payload, stateKey: STATE_CHART_KEY, ...rest };
}

/** 默认剧本：柱状图 + 画完之后指着 3 月讲。 */
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
function repairPlan(hasDiagnostics: boolean): ToolCardPlan {
  if (!hasDiagnostics) {
    return chartCard(BROKEN_DSL, {
      intro: '我先按「销售额」这个列名画一版，你看看。',
      beats: [{ text: '这一版是故意写错的 —— 用来演示诊断回灌的自修复回路。' }],
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
          `  · 看看各渠道的月度销量\n` +
          `  · 看一下实时吞吐量\n` +
          `  · 要下发指令（走一遍中断 → 填表 → resume 的人机回环）\n` +
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

  // 已经在修复轮里：不管用户说了什么，都按修复走
  if (input.hasDiagnostics) return repairPlan(true);

  // 用户在图上做了动作：优先应答这件事，因为它比关键词更能说明意图
  if (input.interaction) {
    const plan = interactionPlan(input.interaction, input.state?.chart);
    if (plan) return plan;
  }

  if (/故意|画错|写错|坏|诊断|修复/.test(text)) return repairPlan(false);
  if (/下发|确认参数|填表|参数确认|中断/.test(text)) return confirmPlan();
  if (/实时|趋势|流|追加|访问量|吞吐/.test(text)) return streamingPlan();
  if (/销量|渠道|柱|卖/.test(text)) return salesPlan();

  return textOnlyPlan(text);
}

/** 暴露给测试：几个 DSL 常量。 */
export const SCENARIO_DSL = { SALES_DSL, BROKEN_DSL, TRAFFIC_DSL, CONFIRM_FORM_DSL };
