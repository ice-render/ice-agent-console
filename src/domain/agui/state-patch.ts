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
