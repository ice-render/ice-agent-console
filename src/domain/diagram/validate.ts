/**
 * 图 DSL 的 kind-first 校验。
 *
 * **永不抛异常** —— 与 `ice-chart-dsl` / `ice-web-components-dsl` 的上游校验器同口径。
 * 这不是风格问题：卡片那条**自修复回路**靠的就是「渲染端拿结构化诊断回灌，agent 据此吐修正版」
 * （见 `shared/contract.ts` 的 `DSL_DIAGNOSTICS_CONTEXT_KEY`）。抛异常的话这条路就断了 ——
 * 卡片只会显示"出错了"，agent 拿不到任何可据以修正的信息。
 *
 * 所以 `src/view/card.ts` 的 `mountDiagram()` 是**先校验、通过了才建画布**：
 * 校验不过时一块 canvas 都不建，只把诊断列出来。
 */
import {
  DIAGRAM_KINDS,
  WATER_PIPE_KEYS,
  WATER_ROOT_KEYS,
  WATER_UNIT_KEYS,
  isDiagramKind,
  isMedium,
  isPort,
  isSymbolKind,
  MEDIUM_STYLES,
  SYMBOL_KINDS,
} from './types';

export interface DiagramDiagnostic {
  severity: 'error' | 'warning';
  /** 出错位置，如 `units[3].kind`；整体性错误用 `''` */
  path: string;
  message: string;
}

export interface DiagramValidationResult {
  valid: boolean;
  errors: DiagramDiagnostic[];
  warnings: DiagramDiagnostic[];
}

/**
 * 诊断条数上限。
 *
 * 一份完全写错的载荷（比如把 units 写成字符串数组）会逐条报出几十个错，
 * 全塞进 context 回灌给模型既浪费 token 又淹掉真正的第一条原因。
 */
const MAX_REPORTED = 8;

/** 坐标的合理量级：超出这个范围基本可以断定是算错了（也顺手挡掉 NaN / Infinity）。 */
const COORD_LIMIT = 1e5;

const err = (path: string, message: string): DiagramDiagnostic => ({ severity: 'error', path, message });
const warn = (path: string, message: string): DiagramDiagnostic => ({ severity: 'warning', path, message });

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 指出多写的字段（kind-first 的字段白名单）。返回多余字段名。 */
function extraKeys(obj: Record<string, any>, allowed: readonly string[]): string[] {
  return Object.keys(obj).filter((key) => allowed.indexOf(key) < 0);
}

/** 把诊断渲染成回灌给 agent 的多行文本；没有可报的就返回 null。 */
export function formatDiagramDiagnostics(result: DiagramValidationResult): string | null {
  const lines: string[] = [];
  for (const d of result.errors) {
    lines.push(`[错误] ${d.path ? d.path + '：' : ''}${d.message}`);
  }
  for (const d of result.warnings) {
    lines.push(`[警告] ${d.path ? d.path + '：' : ''}${d.message}`);
  }
  return lines.length ? lines.join('\n') : null;
}

/**
 * 校验一份图 DSL。
 *
 * 只做到"结构 + 取值合法"，不做工艺语义校验 ——
 * 「出水路径上必须有在线监测」那类规则属于引擎的 `validateWater()`，
 * 跑在真实图元上（`DiagramLayer.issues()`），比在这里模仿一遍可靠。
 */
export function validateDiagramDsl(input: unknown): DiagramValidationResult {
  const errors: DiagramDiagnostic[] = [];
  const warnings: DiagramDiagnostic[] = [];

  const push = (list: DiagramDiagnostic[], d: DiagramDiagnostic) => {
    if (list.length < MAX_REPORTED) list.push(d);
  };
  const e = (path: string, message: string) => push(errors, err(path, message));
  const w = (path: string, message: string) => push(warnings, warn(path, message));

  if (!isPlainObject(input)) {
    e('', `图 DSL 必须是一个对象，收到 ${input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input}`);
    return { valid: false, errors, warnings };
  }

  // ---- kind：kind-first 的分派依据，先看它 ----
  const kind = input.kind;
  if (kind === undefined) {
    e('kind', `缺少 kind；目前支持：${DIAGRAM_KINDS.join(', ')}`);
    return { valid: false, errors, warnings };
  }
  if (!isDiagramKind(kind)) {
    e('kind', `未知的 kind「${String(kind)}」；目前支持：${DIAGRAM_KINDS.join(', ')}`);
    return { valid: false, errors, warnings };
  }

  for (const key of extraKeys(input, WATER_ROOT_KEYS)) {
    w(key, `多余的字段「${key}」会被忽略；本 kind 只认 ${WATER_ROOT_KEYS.join(' / ')}`);
  }

  // ---- viewport.focus：初始视野的聚焦单元（可选） ----
  const viewport = input.viewport;
  if (viewport !== undefined) {
    if (!isPlainObject(viewport)) {
      e('viewport', `viewport 必须是对象，收到 ${viewport === null ? 'null' : typeof viewport}`);
    } else {
      for (const key of extraKeys(viewport, ['focus'])) {
        w(`viewport.${key}`, `多余的字段「${key}」会被忽略；viewport 只认 focus`);
      }
      const focus = viewport.focus;
      if (focus !== undefined) {
        if (!Array.isArray(focus)) {
          e('viewport.focus', `focus 必须是单元 id 的数组，收到 ${typeof focus}`);
        } else if (focus.length === 0) {
          w('viewport.focus', 'focus 是空数组，等同于不写（会用全部单元）');
        }
      }
    }
  }

  // ---- units ----
  const units = input.units;
  if (!Array.isArray(units)) {
    e('units', `units 必须是数组，收到 ${units === undefined ? 'undefined' : typeof units}`);
    return { valid: false, errors, warnings };
  }
  if (units.length === 0) {
    e('units', 'units 是空的，没有任何处理单元可画');
    return { valid: false, errors, warnings };
  }

  /** 已登记的单元 id → 它在 units 里的下标（管线端点要按它查）。 */
  const unitIds = new Map<string, number>();
  const seenComponentIds = new Set<string>();

  units.forEach((unit: any, index: number) => {
    const at = `units[${index}]`;
    if (!isPlainObject(unit)) {
      e(at, `必须是对象，收到 ${unit === null ? 'null' : typeof unit}`);
      return;
    }
    if (!isNonEmptyString(unit.id)) {
      e(`${at}.id`, 'id 必填，且必须是非空字符串');
    } else if (unitIds.has(unit.id)) {
      e(`${at}.id`, `id「${unit.id}」重复（已在 units[${unitIds.get(unit.id)}] 出现过）`);
    } else {
      unitIds.set(unit.id, index);
    }
    if (!isSymbolKind(unit.kind)) {
      e(
        `${at}.kind`,
        `未知的符号种类「${String(unit.kind)}」；合法值（${SYMBOL_KINDS.length} 种）：${SYMBOL_KINDS.join(', ')}`
      );
    }
    for (const axis of ['left', 'top'] as const) {
      const value = unit[axis];
      if (!isFiniteNumber(value)) {
        e(`${at}.${axis}`, `${axis} 必须是有穷数字，收到 ${String(value)}`);
      } else if (Math.abs(value) > COORD_LIMIT) {
        e(`${at}.${axis}`, `${axis}=${value} 超出合理范围（±${COORD_LIMIT}），请检查单位`);
      }
    }
    for (const key of extraKeys(unit, WATER_UNIT_KEYS)) {
      w(`${at}.${key}`, `多余的字段「${key}」会被忽略；单元只认 ${WATER_UNIT_KEYS.join(' / ')}`);
    }
  });

  // viewport.focus 引用的单元必须真的存在（要等 units 扫完才能查）
  if (isPlainObject(input.viewport) && Array.isArray(input.viewport.focus)) {
    input.viewport.focus.forEach((id: any, index: number) => {
      if (!isNonEmptyString(id)) {
        e(`viewport.focus[${index}]`, `必须是单元 id 字符串，收到 ${String(id)}`);
      } else if (!unitIds.has(id)) {
        e(`viewport.focus[${index}]`, `引用了不存在的单元「${id}」`);
      }
    });
  }

  // ---- pipes ----
  const pipes = input.pipes;
  if (pipes === undefined) {
    w('pipes', '没有 pipes，图上只有孤立的单元');
  } else if (!Array.isArray(pipes)) {
    e('pipes', `pipes 必须是数组，收到 ${typeof pipes}`);
    return { valid: errors.length === 0, errors, warnings };
  } else {
    // 组件 id 是一个命名空间：单元与管线不能重名，否则 `ice.findComponent` 会取错
    units.forEach((unit: any) => {
      if (isPlainObject(unit) && isNonEmptyString(unit.id)) seenComponentIds.add(unit.id);
    });

    /** 每个单元被引用了几次（用来提示孤立单元）。 */
    const used = new Set<string>();

    pipes.forEach((pipe: any, index: number) => {
      const at = `pipes[${index}]`;
      if (!isPlainObject(pipe)) {
        e(at, `必须是对象，收到 ${pipe === null ? 'null' : typeof pipe}`);
        return;
      }
      if (!isNonEmptyString(pipe.id)) {
        e(`${at}.id`, 'id 必填，且必须是非空字符串');
      } else if (seenComponentIds.has(pipe.id)) {
        e(`${at}.id`, `id「${pipe.id}」与已有的单元 / 管线重名；组件 id 全局唯一`);
      } else {
        seenComponentIds.add(pipe.id);
      }

      for (const end of ['sourceId', 'targetId'] as const) {
        const value = pipe[end];
        if (!isNonEmptyString(value)) {
          e(`${at}.${end}`, `${end} 必填，且必须是非空字符串`);
        } else if (!unitIds.has(value)) {
          e(`${at}.${end}`, `引用了不存在的单元「${value}」；管线两端都必须是 units 里声明过的 id`);
        } else {
          used.add(value);
        }
      }

      if (!isMedium(pipe.medium)) {
        e(
          `${at}.medium`,
          `未知的介质「${String(pipe.medium)}」；合法值：${Object.keys(MEDIUM_STYLES).join(', ')}`
        );
      }

      for (const end of ['sourcePort', 'targetPort'] as const) {
        const value = pipe[end];
        if (value === undefined) continue; // 不写就走 compile 的兜底
        if (!isPort(value)) {
          e(`${at}.${end}`, `非法端口「${String(value)}」；合法值：T / R / B / L / C`);
        }
      }

      for (const key of extraKeys(pipe, WATER_PIPE_KEYS)) {
        w(`${at}.${key}`, `多余的字段「${key}」会被忽略；管线只认 ${WATER_PIPE_KEYS.join(' / ')}`);
      }
    });

    // ---- 工艺合理性：孤立的单元（可能是漏写了管线，也可能就是这个意思） ----
    units.forEach((unit: any, index: number) => {
      if (isPlainObject(unit) && isNonEmptyString(unit.id) && !used.has(unit.id)) {
        w(`units[${index}]`, `单元「${unit.id}」没有任何管线连接，会成为孤岛`);
      }
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}
