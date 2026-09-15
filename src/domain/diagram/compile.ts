/**
 * 图 DSL → **有序的建图指令**（`DiagramOp[]`）。
 *
 * 刻意做成"纯函数产出指令表"而不是"直接调设计器"：设计器要 ICE 实例、要 canvas、
 * 要 DOM，那样这一层就没法在 node 里单测了。分开之后：
 * - 本文件：纯逻辑，jest 里断言指令的数量与顺序；
 * - `src/view/diagram-layer.ts`：只负责"照着指令调 `createSymbol` / `createPipe`"。
 *
 * 调用约定：**先 `validateDiagramDsl()` 通过，再 `compileDiagramDsl()`**。
 * 本函数按已校验的输入写，不做重复校验（校验规则只有一份，在 `validate.ts`）。
 */
import type { DiagramDslDocument, DiagramPort } from '../../../shared/diagram';

/**
 * 管线端口的**兜底值**。⚠️ 与引擎的默认值**故意不同**，这是本文件最容易踩的地方。
 *
 * 引擎 `WaterProcessDesigner.createPipe()` 的默认是 `sourcePort: 'B'` / `targetPort: 'T'`
 * （下 → 上）。给排水工艺图的主流程是**从左往右**走的，所以图纸惯例是 `R → L`
 * （出口在右边，进口在左边）。
 *
 * 真实影响：案例数据 37 条管线里**有 28 条没写端口**。沿用引擎默认值的话，这 28 条会全部
 * 变成"先向下、再绕回来"的走向 —— 不是审美差异，是整张图换一个画法。
 * `ice-smart-water` 的 `buildCase()` 也是这么兜的（`sourcePort || 'R'`），此处与之对齐。
 */
export const DEFAULT_SOURCE_PORT: DiagramPort = 'R';
export const DEFAULT_TARGET_PORT: DiagramPort = 'L';

/** 一条建图指令。 */
export type DiagramOp =
  | {
      op: 'symbol';
      id: string;
      kind: string;
      name: string;
      tag: string;
      left: number;
      top: number;
    }
  | {
      op: 'pipe';
      id: string;
      sourceId: string;
      targetId: string;
      medium: string;
      dn: string;
      sourcePort: DiagramPort;
      targetPort: DiagramPort;
    };

/**
 * 把一份（已校验的）图 DSL 编译成建图指令。
 *
 * **顺序是承重的**：先全部 `symbol`、再全部 `pipe`。
 * `createPipe()` 会在端点找不到时抛 `'管线两端必须是已存在的符号'`，
 * 所以单元必须先全部建出来。
 */
export function compileDiagramDsl(doc: DiagramDslDocument): DiagramOp[] {
  const ops: DiagramOp[] = [];

  for (const unit of doc.units || []) {
    ops.push({
      op: 'symbol',
      id: unit.id,
      kind: unit.kind,
      // 名称与位号允许省略：符号的 `syncShape()` 会按预设补位号前缀，缺名字就不画那一行
      name: unit.name === undefined ? '' : String(unit.name),
      tag: unit.tag === undefined ? '' : String(unit.tag),
      left: Number(unit.left),
      top: Number(unit.top),
    });
  }

  for (const pipe of doc.pipes || []) {
    ops.push({
      op: 'pipe',
      id: pipe.id,
      sourceId: pipe.sourceId,
      targetId: pipe.targetId,
      medium: pipe.medium,
      dn: pipe.dn === undefined ? '' : String(pipe.dn),
      sourcePort: pipe.sourcePort ?? DEFAULT_SOURCE_PORT,
      targetPort: pipe.targetPort ?? DEFAULT_TARGET_PORT,
    });
  }

  return ops;
}

/** 指令表里各类指令的条数（单测与调试用）。 */
export function countOps(ops: DiagramOp[]): { symbols: number; pipes: number } {
  let symbols = 0;
  let pipes = 0;
  for (const op of ops) {
    if (op.op === 'symbol') symbols += 1;
    else pipes += 1;
  }
  return { symbols, pipes };
}
