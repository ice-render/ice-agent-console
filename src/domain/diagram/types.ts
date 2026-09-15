/**
 * 图 DSL 的**取值白名单**（运行时）。
 *
 * ## 为什么不在这里抄一张表
 *
 * 符号种类（31）与介质（9）的真正定义在 `ice-entity-designer` 里，是它画图的依据。
 * 在本仓复制一份的后果不是今天写错，而是**将来静默漂移**：上游加了一种符号，
 * agent 产出的 DSL 完全合法，本仓的校验器却把它判成"未知种类" ——
 * 这类"两边各有一份真相"的分歧正是 `shared/contract.ts` 抬头警告的那种最难查的 bug。
 *
 * 所以这里只做转发，不复制。jest 侧靠 `moduleNameMapper` 让这个包在 node 环境可加载；
 * 打包侧靠 webpack 的 `resolve.alias` 把它钉到同级仓库目录（避免第二份 `ice-render` 内核）。
 *
 * ## 为什么这个文件不能进 `shared/`
 *
 * 它 import 了上游包，而上游包 re-export 了整个 `ice-render`（引用 DOM）。
 * `tsconfig.server.json` 故意不加载 DOM lib，把它拖进去那道门禁就形同虚设了。
 */
import {
  WATER_MEDIUM_STYLES,
  WATER_SYMBOL_KINDS,
  WATER_SYMBOL_PRESETS,
  WATER_VALVE_KINDS,
  isWaterValveKind,
} from 'ice-entity-designer';
import type { WaterSymbolKind, WaterMedium } from 'ice-entity-designer';
import { DIAGRAM_KINDS, DIAGRAM_PORTS } from '../../../shared/diagram';
import type { DiagramKind, DiagramPort } from '../../../shared/diagram';

export { DIAGRAM_KINDS, DIAGRAM_PORTS };
export type { DiagramKind, DiagramPort };

/** 31 种符号种类（转发上游，只读）。 */
export const SYMBOL_KINDS: readonly string[] = WATER_SYMBOL_KINDS;

/** 9 种介质的样式表；键就是合法介质。 */
export const MEDIUM_STYLES: Record<string, any> = WATER_MEDIUM_STYLES;

/** 符号预设（每个 kind 的默认尺寸与位号前缀）。 */
export const SYMBOL_PRESETS: Record<string, any> = WATER_SYMBOL_PRESETS;

export { WATER_VALVE_KINDS, isWaterValveKind };
export type { WaterSymbolKind, WaterMedium };

/** 某个 kind 是不是合法符号种类。 */
export function isSymbolKind(value: unknown): value is WaterSymbolKind {
  return typeof value === 'string' && SYMBOL_KINDS.indexOf(value) >= 0;
}

/** 某个值是不是合法介质。 */
export function isMedium(value: unknown): value is WaterMedium {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MEDIUM_STYLES, value);
}

/** 某个值是不是合法端口。 */
export function isPort(value: unknown): value is DiagramPort {
  return typeof value === 'string' && (DIAGRAM_PORTS as readonly string[]).indexOf(value) >= 0;
}

/** 某个值是不是合法 kind。 */
export function isDiagramKind(value: unknown): value is DiagramKind {
  return typeof value === 'string' && (DIAGRAM_KINDS as readonly string[]).indexOf(value) >= 0;
}

/**
 * 每个 kind 各自允许的字段（kind-first 的字段白名单）。
 *
 * 与 `ice-web-components-dsl` 的 `TYPE_FIELD_KEYS` 同构：**多写的字段会被指出来**，
 * 而不是被静默忽略 —— 静默忽略会让 agent 以为自己表达成功了，于是反复写同样的无效字段。
 */
export const WATER_UNIT_KEYS = ['id', 'kind', 'name', 'tag', 'left', 'top'] as const;
export const WATER_PIPE_KEYS = [
  'id',
  'sourceId',
  'targetId',
  'medium',
  'dn',
  'sourcePort',
  'targetPort',
] as const;
export const WATER_ROOT_KEYS = ['kind', 'title', 'viewport', 'units', 'pipes'] as const;
