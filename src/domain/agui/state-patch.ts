/**
 * JSON Patch（RFC 6902）的一个**明确子集** + 「这批补丁是不是单纯往表里追加行」的识别。
 *
 * 为什么手写而不是引依赖：AG-UI 的 `STATE_DELTA` 规定用 JSON Patch，但 agent 实际会用的
 * 只有 `add` 一种操作（我们这边只往 `data.rows` 末尾追加）。为了三种操作引一个包，
 * 换来一整套 API 面，不划算。
 *
 * 代价必须说清楚：**不支持的操作会抛异常，不会静默忽略**。
 * 静默忽略一个 `remove` 会让前端状态和 agent 状态悄悄分叉，那种 bug 只在很久以后
 * 以"图怎么不对"的形式浮现。宁可当场炸。等 agent 真的开始发别的操作，
 * 要么在这里补齐，要么那时再引依赖——到时候判断依据是真实的，而不是猜的。
 */

export interface JsonPatchOp {
  op: string;
  path: string;
  value?: any;
  from?: string;
}

const SUPPORTED_OPS = ['add', 'replace', 'remove'] as const;
/** 我们约定的"行表"在 DSL 里的位置。DSL 挂在 state.chart 下。 */
export const CHART_ROWS_PATH = '/chart/data/rows';

/** JSON Pointer 转义：`~1` → `/`，`~0` → `~`。 */
function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function tokensOf(pointer: string): string[] {
  if (pointer === '' || pointer === '/') return [];
  if (!pointer.startsWith('/')) {
    throw new Error(`非法的 JSON Pointer（必须以 / 开头）：${pointer}`);
  }
  return pointer.slice(1).split('/').map(unescapeToken);
}

/** 走到 pointer 指向位置的**父容器**，返回容器和最后一段 key。 */
function resolveParent(doc: any, pointer: string): { parent: any; key: string } {
  const tokens = tokensOf(pointer);
  if (tokens.length === 0) throw new Error('不支持整体替换根节点');
  let node = doc;
  for (let i = 0; i < tokens.length - 1; i++) {
    node = node?.[tokens[i]];
    if (node === undefined || node === null) {
      throw new Error(`JSON Patch 路径不存在：${pointer}（在 ${tokens[i]} 处断了）`);
    }
  }
  return { parent: node, key: tokens[tokens.length - 1] };
}

function addAt(parent: any, key: string, value: any, path: string): void {
  if (Array.isArray(parent)) {
    if (key === '-') {
      parent.push(value);
      return;
    }
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`JSON Patch 对数组的索引非法：${path}`);
    }
    if (index > parent.length) {
      throw new Error(`JSON Patch 追加位置越界：${path}（长度 ${parent.length}）`);
    }
    parent.splice(index, 0, value);
    return;
  }
  if (parent && typeof parent === 'object') {
    parent[key] = value;
    return;
  }
  throw new Error(`JSON Patch 的父容器不是对象或数组：${path}`);
}

function removeAt(parent: any, key: string, path: string): void {
  if (Array.isArray(parent)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
      throw new Error(`JSON Patch 删除位置越界：${path}`);
    }
    parent.splice(index, 1);
    return;
  }
  if (parent && typeof parent === 'object') {
    delete parent[key];
    return;
  }
  throw new Error(`JSON Patch 的父容器不是对象或数组：${path}`);
}

/**
 * 应用一批补丁，返回**新文档**（不改动入参）。
 *
 * 不可变很重要：状态树会被回放器、对比、撤销栈共享，就地改会让那些东西互相污染。
 */
export function applyJsonPatch<T>(doc: T, ops: JsonPatchOp[]): T {
  if (!Array.isArray(ops)) {
    throw new Error('STATE_DELTA 的 delta 必须是数组');
  }
  const next = structuredClone(doc) as any;
  for (const op of ops) {
    if (!op || typeof op.path !== 'string') {
      throw new Error(`JSON Patch 操作缺少 path：${JSON.stringify(op)}`);
    }
    if (!(SUPPORTED_OPS as readonly string[]).includes(op.op)) {
      throw new Error(
        `JSON Patch 操作「${op.op}」不在已实现的子集里（只支持 ${SUPPORTED_OPS.join(' / ')}）。` +
          '要加的话在 src/domain/agui/state-patch.ts 里补，别让它被静默忽略。'
      );
    }
    if (op.op === 'remove') {
      const { parent, key } = resolveParent(next, op.path);
      removeAt(parent, key, op.path);
      continue;
    }
    const { parent, key } = resolveParent(next, op.path);
    if (op.op === 'replace') {
      removeAt(parent, key, op.path);
    }
    addAt(parent, key, structuredClone(op.value), op.path);
  }
  return next;
}

export interface RowAppendDetection {
  /** 这批补丁是不是"只往 rows 末尾追加行"。 */
  isPlainAppend: boolean;
  /** 追加的行（按补丁顺序）。 */
  rows: any[][];
}

/**
 * 识别"单纯追加数据行"。
 *
 * **这个函数是这个工程里最像"适配层"的东西**，值得解释它在解决什么：
 *
 * 协议层面，agent 说的是"state 变了，这是 JSON Patch"。渲染层面，ICE 收到
 * 全量 `setOption` 也能画对，但那意味着每个数据点都要重新编译一遍 DSL、
 * 重建整个坐标系。而 `appendData` 是专为"只加几个点"准备的快路径。
 *
 * 总得有人在中间做这次翻译。放在这里而不是散在视图里，是因为它是纯函数——
 * 边界情况（混合操作、嵌套路径、越界）可以被穷举测掉，而不用担心要起一个画布。
 */
export function detectRowAppend(
  ops: JsonPatchOp[],
  rowsPath: string = CHART_ROWS_PATH
): RowAppendDetection {
  if (!Array.isArray(ops) || ops.length === 0) {
    return { isPlainAppend: false, rows: [] };
  }
  const suffix = `${rowsPath}/-`;
  const rows: any[][] = [];
  for (const op of ops) {
    if (op?.op !== 'add' || op.path !== suffix) {
      return { isPlainAppend: false, rows: [] };
    }
    if (!Array.isArray(op.value)) {
      return { isPlainAppend: false, rows: [] };
    }
    rows.push(op.value);
  }
  return { isPlainAppend: true, rows };
}

/** 图元表在 state 里的位置。DSL 挂在 `state.diagram` 下。 */
export const DIAGRAM_UNITS_PATH = '/diagram/units';
export const DIAGRAM_PIPES_PATH = '/diagram/pipes';
/**
 * `viewport.focus` 在 state 里的位置。
 *
 * 它也在"改图"这批补丁里，但**语义上不是一个独立的操作** ——
 * 删掉一个单元时必须把这个 id 从 focus 里摘掉，否则 `focus` 会指向一个不存在的单元
 * （守卫会报"引用了不存在的单元"）。所以：
 * - 识别时**不算"碰了别的东西"**（不然整批退回全量重建，白丢一次增量）；
 * - 但它自己**不产生**要增删的图元。
 */
export const DIAGRAM_FOCUS_PATH = '/diagram/viewport/focus';

export interface DiagramPatchDetection {
  /**
   * 这批补丁是不是"只增删图元"。
   *
   * 判据是"没碰 units / pipes / viewport.focus 之外的任何东西"——
   * focus 那一路是"删单元"的附属动作，不视为跑题（见 `DIAGRAM_FOCUS_PATH`）。
   */
  isElementPatch: boolean;
  /**
   * 要**新增**的单元 / 管线（按补丁顺序）。
   *
   * 只有 `add` 到 `…/-`（末尾追加）才算 —— 往数组中间插也能做，
   * 但"中间插入"对图元来说是"顺序变了"而不是"新增了"，语义不同，所以不认。
   */
  units: any[];
  pipes: any[];
  /**
   * 要**删除**的单元 / 管线 id。
   *
   * ⚠️ 补丁里给的是**下标**（`/diagram/units/3`），不是 id —— JSON Patch 就是这么规定的。
   * 所以这个函数**必须拿到补丁前的那份文档**才能把下标翻译成 id
   * （`before` 参数）。少了它就只能删错东西，或者退化成"全量重建"。
   */
  removedUnitIds: string[];
  removedPipeIds: string[];
}

/**
 * 识别"这次只是增删了几个图元"。纯函数，边界情况可以被穷举测掉。
 *
 * ## 为什么值得单开一条路径（而不是让 `STATE_DELTA` 一律走全量重建）
 *
 * 图是全页主体，重建一次要重新 `createSymbol` 60~70 次、重算视口、丢用户的缩放平移 ——
 * 而"提标改造加三个池子"这种事，物理上就是三次 `createSymbol` + 四根 `createPipe`。
 * `FlowDesigner` 本来就提供了增量原语（`createSymbol` / `createPipe` / `remove`），
 * 不用白不用。
 *
 * ## 为什么和 `detectRowAppend` 分开两个函数
 *
 * 两者识别的是**不同的东西**：一个说"表在长"，一个说"图在变"。
 * 合成一个"万能识别器"会让两边的最简情况都变复杂，而且它们的失败姿势完全不同
 * （追加认错了 = 图少几个点；增删认错了 = 图多/少一个池子）。
 *
 * @param ops    这批 JSON Patch
 * @param before **补丁之前**的 state 文档（解析被删下标要用）
 */
export function detectDiagramPatch(
  ops: JsonPatchOp[],
  before: any,
  unitsPath: string = DIAGRAM_UNITS_PATH,
  pipesPath: string = DIAGRAM_PIPES_PATH,
  focusPath: string = DIAGRAM_FOCUS_PATH
): DiagramPatchDetection {
  const empty: DiagramPatchDetection = {
    isElementPatch: false,
    units: [],
    pipes: [],
    removedUnitIds: [],
    removedPipeIds: [],
  };
  if (!Array.isArray(ops) || ops.length === 0) return empty;

  const units: any[] = [];
  const pipes: any[] = [];
  const removedUnitIds: string[] = [];
  const removedPipeIds: string[] = [];

  for (const op of ops) {
    if (!op || typeof op.path !== 'string') return empty;

    // `viewport.focus` 的删除：**允许，但不产生图元**。
    // 它是"删单元"的附属动作（见 `DIAGRAM_FOCUS_PATH`）。只做基本的下标校验 ——
    // 越界说明编补丁的人算错了，那种错误宁可退回全量也别装作没事。
    if (op.path.startsWith(`${focusPath}/`)) {
      if (op.op !== 'remove') return empty;
      const focusIndex = Number(op.path.slice(focusPath.length + 1));
      const focus = before?.diagram?.viewport?.focus;
      if (!Number.isInteger(focusIndex) || focusIndex < 0) return empty;
      if (!Array.isArray(focus) || focusIndex >= focus.length) return empty;
      continue;
    }

    const target = op.path.startsWith(`${unitsPath}/`)
      ? 'units'
      : op.path.startsWith(`${pipesPath}/`)
        ? 'pipes'
        : null;
    if (!target) return empty; // 碰了别的东西 → 整批不认，走全量

    const base = target === 'units' ? unitsPath : pipesPath;
    const tail = op.path.slice(base.length + 1);

    if (op.op === 'add' && tail === '-') {
      if (!op.value || typeof op.value !== 'object' || Array.isArray(op.value)) return empty;
      (target === 'units' ? units : pipes).push(op.value);
      continue;
    }

    if (op.op === 'remove') {
      const index = Number(tail);
      if (!Number.isInteger(index) || index < 0) return empty;
      const list = before?.diagram?.[target];
      if (!Array.isArray(list) || index >= list.length) return empty;
      const id = list[index]?.id;
      if (typeof id !== 'string' || !id) return empty;
      (target === 'units' ? removedUnitIds : removedPipeIds).push(id);
      continue;
    }

    // `replace`（改一个图元）/ `move` / `copy` 都不认：它们不是"增删"。
    // 退回全量重建 —— 结果一样对，只是贵一点。**不要**在这里顺手实现 replace，
    // 那会把"图元被就地改了"和"图元被换了一个"两种语义混在一起。
    return empty;
  }

  if (!units.length && !pipes.length && !removedUnitIds.length && !removedPipeIds.length) {
    return empty;
  }
  return { isElementPatch: true, units, pipes, removedUnitIds, removedPipeIds };
}
