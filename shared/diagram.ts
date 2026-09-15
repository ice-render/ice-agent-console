/**
 * 图 DSL 的**类型与本仓自有的 kind 清单**。
 *
 * ## 为什么类型放 `shared/` 而不是 `src/domain/`
 *
 * 两边都要用，但不走同一条编译链：`tsconfig.server.json` 只 include `["server", "shared"]`
 * 且**故意不加载 DOM lib**，所以 `server/` 里的剧本字面量拿不到 `src/domain/**` 的类型。
 * 类型放这里，「agent 产出的载荷」与「客户端的校验器」才有编译期联动 ——
 * 否则载荷写错了要等运行时才发现（这正是本仓 `shared/` 目录存在的理由，见 contract.ts 抬头）。
 *
 * ## 为什么 `kind` / `medium` 这里只写 `string`
 *
 * 它们的**合法取值来自 `ice-entity-designer`**（`WATER_SYMBOL_KINDS` / `WATER_MEDIUM_STYLES`）。
 * 但那个包的类型引用了 DOM（它 re-export 了整个 `ice-render`），从 `shared/` import 它会
 * 把 DOM 类型拖进 server 那套 tsconfig，门禁就假了。
 *
 * 所以分成两层，各管各的：
 * - **这里**：结构（有哪些字段、什么形状）—— 编译期管；
 * - **`src/domain/diagram/`**：取值白名单（31 个符号种类 / 9 种介质）—— 运行时管，
 *   且直接从上游包 import，保证引擎加了 kind 之后不会静默漂移。
 */

/**
 * 图 DSL 的 kind 白名单。
 *
 * kind-first：文档顶层的 `kind` 决定「谁来校验、谁来编译、画成什么」。
 * 新增一种图（流程图 / BPMN / UML…）的步骤是：这里加一个 kind +
 * `src/domain/diagram/` 加一组规则 + `diagram-layer` 加一个分支，**不动卡片体系**。
 */
export const DIAGRAM_KINDS = ['water-process'] as const;

export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

/**
 * 连线端点（对接哪个"槽位"）。
 *
 * `C` 是居中，其余四个是上右下左。取值与引擎的 `FlowPort` 一致 ——
 * 这里重写一遍而不是 import，理由同上（不把 DOM 类型拖进 server）。
 */
export const DIAGRAM_PORTS = ['T', 'R', 'B', 'L', 'C'] as const;

export type DiagramPort = (typeof DIAGRAM_PORTS)[number];

/** 一个处理单元 / 设备 / 边界（画成一个符号）。 */
export interface WaterProcessUnit {
  /** 必填且在一份文档里唯一（管线的 `sourceId`/`targetId` 引用它） */
  id: string;
  /** 符号种类，取值见 `WATER_SYMBOL_KINDS`（31 种） */
  kind: string;
  /** 中文名（画在符号下方） */
  name?: string;
  /** 位号（画在符号上方，如 `AE-101`） */
  tag?: string;
  left: number;
  top: number;
}

/** 一段管线（画成一条带介质着色的连线）。 */
export interface WaterProcessPipe {
  id: string;
  sourceId: string;
  targetId: string;
  /** 介质，取值见 `WATER_MEDIUM_STYLES`（9 种），决定颜色与线型 */
  medium: string;
  /** 管径标注（如 `DN600`）；信号线 / 动力线没有管径，留空 */
  dn?: string;
  /**
   * 起点 / 终点槽位。**不写时的兜底不是引擎的默认值** ——
   * 引擎 `createPipe` 默认 `B → T`（向下再绕回来），而给排水图纸的惯例是
   * 主流程从左往右走，所以本 DSL 的兜底是 `R → L`。见 `compile.ts` 的 `DEFAULT_*_PORT`。
   */
  sourcePort?: DiagramPort;
  targetPort?: DiagramPort;
}

/** 给水排水工艺流程图（`kind: 'water-process'`）。 */
export interface WaterProcessDslDocument {
  kind: 'water-process';
  /** 可选标题 */
  title?: string;
  /**
   * 初始视图提示（可选）。
   *
   * 为什么让**数据**来说"先看哪儿"而不是让渲染端猜：这张图的世界尺寸约 1454×985，
   * 而卡片可用宽度只有 ~872px —— 整图适配会把 12px 的位号压到 6~7px。
   * 与其写一个"哪一行是主流程"的启发式（行聚类？最长链？都不可靠），
   * 不如让画这张图的人直接说清楚。图纸格式（Visio / draw.io / Excalidraw）普遍都带初始视图。
   */
  viewport?: {
    /** 要框进初始视野的单元 id；不写则用全部单元 */
    focus?: string[];
  };
  units: WaterProcessUnit[];
  pipes: WaterProcessPipe[];
}

/**
 * 图 DSL 文档。目前只有一种 kind，所以这个联合只有一个成员 ——
 * 留着联合的形状是为了让加 kind 时调用方不必改类型。
 */
export type DiagramDslDocument = WaterProcessDslDocument;
