/**
 * 给模型的**工具定义**与**系统提示词**。
 *
 * ## 为什么用 tool calling，而不是"让模型吐 JSON 再解析"
 *
 * 因为这一整条链路本来就是 tool call 的形状：AG-UI 的事件流里
 * `TOOL_CALL_START/ARGS/END/RESULT` 是原生成员，前端按 `toolCallName` 决定渲染成哪种卡片。
 * 让模型走 tool calling，协议层与卡片层**都不用为"文本里挖 JSON"做任何妥协**。
 *
 * ## 为什么 schema 写得**不**穷尽
 *
 * 表单 DSL 的完整约束有 38 个错误码（见 `ice-web-components-dsl` 的 SKILL）。
 * 把它全塞进 tool schema 有两个问题：token 贵，而且**模型的错误率并不会因此归零** ——
 * 值语义（"默认值必须在 options 里"）本来就不是 JSON Schema 能表达的。
 *
 * 所以这里只写**结构骨架**，把值语义交给下游：
 * `validateFormDsl` / `validateChartDsl` 会给出带"可用取值 / 可用类型"的结构化诊断，
 * 前端把诊断经 `context` 回灌，下一轮模型自己改。**那条自修复回路本来就在**
 * （见 README「诊断回灌的自修复」），这里没必要重复实现一遍校验。
 *
 * 顺带一个好处：M1（剧本）与 M2（模型）**共用同一条自修复回路** ——
 * 剧本是"故意写错"，模型是"真的写错"，回路的代码一行不差。
 */

/** 表单 DSL 的字段类型，与 `ice-web-components-dsl` 的 `FORM_DSL_FIELD_TYPES` 对齐。 */
const FORM_FIELD_TYPES = [
  'text', 'textarea', 'password', 'number', 'slider', 'checkbox', 'switch',
  'radio-group', 'checkbox-group', 'select', 'date', 'color', 'rate', 'time',
  'segmented', 'autocomplete', 'cascader', 'tree-select', 'transfer', 'date-range',
];

/** 图表类型，与 `ice-chart-dsl` 的 `kind` 对齐。 */
const CHART_KINDS = ['bar', 'line', 'pie', 'area', 'scatter'];

/**
 * 工具定义（OpenAI 的 `tools` 形状）。
 *
 * 名字与前端的分派表（`shared/contract.ts` 的 `RENDER_CHART_TOOL` /
 * `COLLECT_INPUT_TOOL`）**必须一致** —— 前端就是按名字决定渲染成图表卡还是表单卡的。
 */
export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'render_chart',
      description:
        '把数据画成图表，内联成对话里的一张卡片。用在用户要看数据、趋势、对比的时候。' +
        '需要已经有数据；没有数据就先说明拿不到，不要编造。',
      parameters: {
        type: 'object',
        required: ['kind', 'data', 'encoding'],
        properties: {
          schemaVersion: { type: 'number', description: '写 1' },
          kind: { type: 'string', enum: CHART_KINDS, description: '图表类型' },
          title: { type: 'string', description: '图标题' },
          data: {
            type: 'object',
            required: ['columns', 'rows'],
            properties: {
              columns: { type: 'array', items: { type: 'string' }, description: '列名，按顺序' },
              rows: {
                type: 'array',
                items: { type: 'array' },
                description: '数据行，每个单元格是字符串或数字。每行长度与 columns 一致',
              },
            },
          },
          encoding: {
            type: 'object',
            description: '把列名映射到视觉通道',
            required: ['x', 'y'],
            properties: {
              x: { type: 'string', description: 'x 轴用哪一列（必须是 columns 里的名字）' },
              y: { type: 'string', description: 'y 轴用哪一列' },
              series: { type: 'string', description: '分组用哪一列（可选，分组柱状/多折线用）' },
            },
          },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'collect_input',
      description:
        '**需要用户提供信息时**用它 —— 会渲染成一张可填的表单，并让这一轮停下来等用户提交。' +
        '典型场景：要下发指令前确认参数、信息不全需要补、让用户做选择。' +
        '不要用纯文字问问题，用户没法在对话里可靠地填结构化参数。',
      parameters: {
        type: 'object',
        required: ['kind', 'fields'],
        properties: {
          schemaVersion: { type: 'number', description: '写 1' },
          kind: { type: 'string', enum: ['form'], description: '固定 "form"' },
          title: { type: 'string', description: '表单标题' },
          description: { type: 'string', description: '为什么需要这些信息（一句话）' },
          fields: {
            type: 'array',
            description: '字段列表，至少一个',
            items: {
              type: 'object',
              required: ['name', 'type'],
              properties: {
                name: { type: 'string', description: '取值键，唯一，英文小驼峰' },
                type: { type: 'string', enum: FORM_FIELD_TYPES },
                label: { type: 'string', description: '中文标签' },
                placeholder: { type: 'string' },
                default: {
                  description:
                    '初始值。形状随类型：标量类型是字符串/数字/布尔；transfer 与多选 select/checkbox-group 是数组；' +
                    'date-range 是两头齐全的数组 ["2026-01-01","2026-01-31"]',
                },
                required: { type: 'boolean' },
                min: { type: 'number', description: 'number/slider/rate 上同时约束控件与校验' },
                max: { type: 'number', description: 'rate 上是满分几颗星' },
                maxLength: { type: 'number', description: '文本类上同时限制输入长度与校验' },
                pattern: { type: 'string', description: '正则**字符串**' },
                message: { type: 'string', description: '校验失败时的自定义文案' },
                options: {
                  type: 'array',
                  description:
                    '选项型字段必需：select / radio-group / checkbox-group / segmented / color / ' +
                    'autocomplete / cascader / tree-select / transfer。可以写 ["a","b"]，' +
                    '也可以写 [{value,label}]；cascader / tree-select 在项上写 children 往下嵌',
                  items: {},
                },
                mode: { type: 'string', description: 'select: single|multiple|tags；tree-select: single|multiple' },
                showSearch: { type: 'boolean' },
                format: { type: 'string', enum: ['HH:mm:ss', 'HH:mm'], description: 'time 的值格式' },
                separator: { type: 'string', description: 'cascader 已选路径的分隔符' },
                submitText: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'point_at',
      description:
        '**画完图之后**，如果你想指着某个数据点讲，用它把高亮落到那个点上。' +
        'x 值必须是刚画那张图的 x 轴刻度之一。一次只指一个点。',
      parameters: {
        type: 'object',
        required: ['xValue'],
        properties: {
          xValue: { type: 'string', description: '要指着的 x 值，例如 "3月"' },
        },
      },
    },
  },
];

/**
 * 系统提示词。
 *
 * 刻意**短**：结构约束在 tool schema 里，值语义的约束在下游诊断里，
 * 这里只讲"怎么选工具"和"输出该长什么样"。提示词越长越容易跟 schema 打架。
 *
 * 完整规范在 `ice-web-components-dsl` 的 `skills/ice-web-components-dsl/SKILL.md`，
 * 需要时可以把它读进来注入 —— 但对常见场景，schema + 诊断已经够用。
 */
export const SYSTEM_PROMPT = `你是 ice-agent-console 里的 agent。你的回复会显示在一个对话界面里，
你说的每句话都会以文字气泡出现；你调用的工具会把**图表或表单内联成一张卡片**画在对话里。

工作方式：
1. 先想清楚用户要什么。要看数据 → 调 render_chart；需要用户提供信息 → 调 collect_input。
2. 需要调工具时，**先说一句你要做什么**（这句话会排在卡片前面），然后调工具。
3. 工具调完（或本轮不需要工具）之后，**再给一句结论**。有图的话，结论要针对图里的
   具体数字讲，别只复述"图画好了"。
4. 数据不足时**如实说**，不要编造数字；可以改用 collect_input 问用户要。

风格：
- 中文，简短，像同事说话。
- 不要用 markdown 标题/粗体堆砌，界面里看起来会很吵。
- 不要在回复里贴 JSON —— 参数走工具调用，用户看不到也不需要看。`;

/** 上一轮渲染端回灌了诊断时，追加的一段。这是自修复回路的提示词侧。 */
export const REPAIR_HINT = `【重要】上一轮你给的东西**没有通过渲染端的校验**，诊断在下面的上下文里。
请逐条对照诊断修好它，重新调用工具。诊断里会写明可用的取值 / 可用的类型 —— 照着改，不要猜。`;
