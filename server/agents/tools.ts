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

/** 图 DSL 的 kind，与 `shared/diagram.ts` 的 `DIAGRAM_KINDS` 对齐。 */
const DIAGRAM_KINDS = ['water-process'];

/**
 * 给排水工艺图的符号种类，与 `ice-entity-designer` 的 `WATER_SYMBOL_KINDS` 对齐。
 *
 * 与 `FORM_FIELD_TYPES` 一样是**为了 schema 可读而抄的一份**：真正的白名单在上游包里，
 * 客户端校验器（`src/domain/diagram/types.ts`）直接从那边转发。这里抄这一份的原因是
 * 模型需要看到合法取值才不至于瞎编 —— 而 schema 里没法写"去 require 那个包"。
 * 上游加种类时两边要一起动；漏了的表现是"模型不画新种类"，不是画错。
 */
const WATER_SYMBOL_KINDS = [
  'barScreen', 'gritChamber', 'primaryClarifier', 'anaerobicTank', 'anoxicTank',
  'aerobicTank', 'secondaryClarifier', 'coagulationTank', 'filterBed', 'disinfectionTank',
  'storageTank', 'deodorizer',
  'sludgeThickener', 'dewateringMachine', 'sludgeSilo',
  'pump', 'submersiblePump', 'screwPump', 'blower', 'vfd', 'dosingUnit',
  'valve', 'motorValve', 'checkValve', 'flowMeter', 'levelGauge', 'pressureGauge', 'analyzer',
  'inlet', 'outlet', 'sludgeOut',
];

/** 介质，与 `ice-entity-designer` 的 `WATER_MEDIUM_STYLES` 对齐（决定颜色与线型）。 */
const WATER_MEDIA = [
  'sewage', 'effluent', 'returnSludge', 'recycle', 'sludge', 'air', 'chemical', 'signal', 'power',
];

/**
 * 工具定义（OpenAI 的 `tools` 形状）。
 *
 * 名字与前端的分派表（`shared/contract.ts` 的 `RENDER_CHART_TOOL` /
 * `COLLECT_INPUT_TOOL`）**必须一致** —— 前端就是按名字决定渲染成图表卡还是表单卡的。
 */

/**
 * **锚定**：这张卡片说的是工艺图上的哪个单元。
 *
 * 为什么放在工具参数里而不是 DSL 里：DSL 描述"画什么"（图表的数据与编码、表单有哪些字段），
 * 锚定描述的是"它跟图上的哪个东西有关"—— 那是**卡片与画布的关系**，不是图表内容的一部分。
 * 服务端拿到之后会把它从载荷里**摘掉**再交给渲染端（DSL 校验不认这个键，留着会被打回自修复）。
 *
 * 可选：模型不确定就**不要给** —— 没有锚定只是少了"图上指回那个单元"这层呼应，
 * 卡片本身照常显示；编一个不存在的位号反而更糟。
 */
const ANCHOR_SCHEMA = {
  type: 'object',
  description:
    '这张卡片关联工艺图上的哪个单元（可选）：{"value":"<单元 id 或位号>","label":"<位号，可选>"}。' +
    '例如出水 COD 的趋势锚到 "codAnalyzer"（AIT-106）、给进水泵下指令锚到 "inletPump"（P-101）。' +
    '不确定就不给，不要编一个图上没有的标识。',
  properties: {
    value: { type: 'string', description: '单元 id（如 codAnalyzer）或位号（如 AIT-106）' },
    label: { type: 'string', description: '给用户看的位号 / 名称（可选）' },
  },
  required: ['value'],
} as const;

export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'render_chart',
      description:
        '把数据画成图表，内联成对话里的一张卡片。用在用户要看数据、趋势、对比的时候。' +
        '例：出水 COD 近 6 日趋势（对照一级A 限值）、各工段的电耗对比、进出水氨氮对照。' +
        '需要已经有数据；没有数据就先说明拿不到，不要编造。',
      parameters: {
        type: 'object',
        required: ['kind', 'data', 'encoding'],
        properties: {
          schemaVersion: { type: 'number', description: '写 1' },
          kind: { type: 'string', enum: CHART_KINDS, description: '图表类型' },
          title: { type: 'string', description: '图标题' },
          anchor: ANCHOR_SCHEMA,
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
        '典型场景：下发泵站运行参数前确认、开一张加药与工艺参数调整单、水质异常上报。' +
        '不要用纯文字问问题，用户没法在对话里可靠地填结构化参数。',
      parameters: {
        type: 'object',
        required: ['kind', 'fields'],
        properties: {
          schemaVersion: { type: 'number', description: '写 1' },
          kind: { type: 'string', enum: ['form'], description: '固定 "form"' },
          title: { type: 'string', description: '表单标题' },
          description: { type: 'string', description: '为什么需要这些信息（一句话）' },
          anchor: ANCHOR_SCHEMA,
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
      name: 'render_diagram',
      description:
        '把一张**图**内联成卡片画在对话里（kind-first 的图 DSL）。' +
        '目前只有 `water-process` 一种 kind：给水排水工艺流程图（污水处理厂、给水厂）。' +
        '它与 render_chart 的区别是"图" vs "图表"：图有带位号的构筑物符号、' +
        '按介质着色的管线与流向，适合讲工艺流程；要展示数据用 render_chart。',
      parameters: {
        type: 'object',
        required: ['kind', 'units'],
        properties: {
          kind: {
            type: 'string',
            enum: DIAGRAM_KINDS,
            description: '图的种类。目前只有 water-process。',
          },
          title: { type: 'string', description: '可选标题' },
          viewport: {
            type: 'object',
            description:
              '初始视野提示。图比卡片宽得多，建议指定"先看哪几个单元"的 id。',
            properties: {
              focus: {
                type: 'array',
                items: { type: 'string' },
                description: '要框进初始视野的单元 id',
              },
            },
          },
          units: {
            type: 'array',
            description: '处理单元 / 设备 / 边界（画成带位号的符号）',
            items: {
              type: 'object',
              required: ['id', 'kind', 'left', 'top'],
              properties: {
                id: { type: 'string', description: '唯一 id，管线的两端引用它' },
                kind: { type: 'string', enum: WATER_SYMBOL_KINDS, description: '符号种类' },
                name: { type: 'string', description: '中文名（画在符号下方）' },
                tag: { type: 'string', description: '位号，如 AE-101（画在符号上方）' },
                left: { type: 'number', description: '画布 x 坐标（绝对坐标）' },
                top: { type: 'number', description: '画布 y 坐标（绝对坐标）' },
              },
            },
          },
          pipes: {
            type: 'array',
            description: '管线（画成按介质着色的连线）',
            items: {
              type: 'object',
              required: ['id', 'sourceId', 'targetId', 'medium'],
              properties: {
                id: { type: 'string' },
                sourceId: { type: 'string', description: '起点单元 id' },
                targetId: { type: 'string', description: '终点单元 id' },
                medium: { type: 'string', enum: WATER_MEDIA, description: '介质，决定颜色与线型' },
                dn: { type: 'string', description: '管径标注，如 DN600；信号/动力线留空' },
                sourcePort: { type: 'string', enum: ['T', 'R', 'B', 'L', 'C'], description: '起点槽位，默认 R' },
                targetPort: { type: 'string', enum: ['T', 'R', 'B', 'L', 'C'], description: '终点槽位，默认 L' },
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
        '**画完之后**，如果你想指着某个地方讲，用它把高亮落上去。' +
        '图表：xValue 是 x 轴刻度之一；工艺图：xValue 是单元 id 或位号（如 ana / AE-101）——' +
        '指图里的单元时还会把镜头移过去。一次只指一处。' +
        '想让对方**更容易注意到**这一处时，带上 blink: true 让它闪几下。',
      parameters: {
        type: 'object',
        required: ['xValue'],
        properties: {
          xValue: { type: 'string', description: '要指的地方：图表的 x 值（如 "3月"）或图里的单元 id / 位号（如 ana / AE-101）' },
          blink: {
            type: 'boolean',
            description:
              '高亮之后再闪几下（引注意）。适合「这个位置很关键」这类强调；' +
              '只是顺带提一句就别开，闪多了会吵。目前只有工艺图支持。',
          },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'zoom_view',
      description:
        '**画完之后**，如果你想让对方看得更近或更远，用它缩放视图。' +
        '方向是**相对**的：in 放大、out 缩小（都在当前倍率上叠），reset 回到刚画出来时的初始视野。' +
        '你不需要知道当前倍率 —— 说"放大一点"就用 in。' +
        '适合「看细节」/「看全貌」这类诉求，也常和 point_at 连着用（先指过去、再放大看）。' +
        '目前只有工艺图支持；图表的缩放属于图表自身的坐标轴，不在这个工具的范围内。',
      parameters: {
        type: 'object',
        required: ['direction'],
        properties: {
          direction: {
            type: 'string',
            enum: ['in', 'out', 'reset'],
            description: 'in 放大 / out 缩小 / reset 回到初始视野',
          },
          factor: {
            type: 'number',
            description: '每一步的倍率，默认 1.35。一般不用给 —— 给大了会一步跳到底，看不出在动。',
          },
          steps: {
            type: 'number',
            description: '连走几步，默认 1，最多 6。想说"放大很多"时用 steps: 2 而不是把 factor 调很大。',
          },
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
export const SYSTEM_PROMPT = `你是「智慧水务控制台」里的值班助手，服务对象是一座城镇污水处理厂
（A²/O 工艺，设计规模 10 万 m³/日，出水执行《城镇污水处理厂污染物排放标准》一级A）。
你的回复会显示在一个对话界面里，你说的每句话都会以文字气泡出现；
你调用的工具会把**图表、工艺图或表单内联成一张卡片**画在对话里。

画布上现在是一张污水处理工艺流程图（预处理 → 生化 → 深度处理 → 污泥），
位号按行业惯例编：P-* 泵、GR-* 格栅、GC-* 沉砂池、PC-* 初沉池、AT/AX/AE-* 厌氧/缺氧/好氧池、
SC-* 二沉池、CO-* 混凝沉淀、FL-* 滤池、DT-* 消毒、ST-* 污泥浓缩、DU-* 加药装置、
AIT-* 在线分析仪（COD/氨氮/总磷/总氮/DO/pH/MLSS）、FIT-* 流量计、LT-* 液位计、
PT-* 压力表、MOV-* 电动阀、VFD-* 变频器、B-* 鼓风机。

业务口径（回答时照这个来，别用互联网/电商那类比方）：
- 指标：进水与出水的 COD、氨氮、总氮、总磷、SS、pH、DO、MLSS；出水对照一级A 限值说话；
- 工艺：回流比（混合液内回流、污泥外回流）、污泥龄、曝气量、加药量（PAC/PAM/碳源/次氯酸钠）；
- 异常：进水冲击、污泥膨胀、低温、设备故障、出水超标，处置顺序是"先保出水达标，再查原因"。

工作方式：
1. 先想清楚用户要什么。要看数据 → 调 render_chart；要讲工艺流程/画图 → 调 render_diagram；
   需要用户提供信息 → 调 collect_input。
   画完之后**看图说话**：想指哪儿 → 调 point_at（想强调就带 blink）；
   想让对方看得更近/更远 → 调 zoom_view。这两个只在**画完那张图之后**才调。
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
