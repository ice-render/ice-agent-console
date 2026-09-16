/**
 * JSON Patch 子集 + "这批补丁是不是单纯追加行"的识别。
 *
 * `detectRowAppend` 决定了前端走 `appendData` 快路径还是全量重绘——
 * 判错的后果是**图看着对但内部状态错了**，这类 bug 最难发现，所以边界要穷举。
 */
import {
  CHART_ROWS_PATH,
  applyJsonPatch,
  detectDiagramPatch,
  detectRowAppend,
  type JsonPatchOp,
} from '../src/domain/agui/state-patch';

const baseChart = () => ({
  chart: {
    kind: 'line',
    data: { columns: ['秒', '吞吐'], rows: [[1, 92], [2, 105]] },
    encoding: { x: '秒', y: '吞吐' },
  },
});

describe('applyJsonPatch', () => {
  it('add 到数组末尾', () => {
    const next = applyJsonPatch(baseChart(), [
      { op: 'add', path: `${CHART_ROWS_PATH}/-`, value: [3, 148] },
    ]);
    expect(next.chart.data.rows).toEqual([[1, 92], [2, 105], [3, 148]]);
  });

  it('不改动入参（不可变）', () => {
    const doc = baseChart();
    applyJsonPatch(doc, [{ op: 'add', path: `${CHART_ROWS_PATH}/-`, value: [3, 148] }]);
    expect(doc.chart.data.rows).toHaveLength(2);
  });

  it('replace 覆盖已有位置', () => {
    const next = applyJsonPatch(baseChart(), [
      { op: 'replace', path: `${CHART_ROWS_PATH}/0`, value: [1, 999] },
    ]);
    expect(next.chart.data.rows[0]).toEqual([1, 999]);
  });

  it('remove 删除位置', () => {
    const next = applyJsonPatch(baseChart(), [{ op: 'remove', path: `${CHART_ROWS_PATH}/0` }]);
    expect(next.chart.data.rows).toEqual([[2, 105]]);
  });

  it('path 指向对象字段', () => {
    const next = applyJsonPatch(baseChart(), [{ op: 'replace', path: '/chart/kind', value: 'bar' }]);
    expect(next.chart.kind).toBe('bar');
  });

  it('不支持的 op 抛异常（不静默忽略）', () => {
    // 静默忽略会让前端状态和 agent 状态悄悄分叉，宁可在测试里当场红
    expect(() => applyJsonPatch(baseChart(), [{ op: 'move', path: '/a', from: '/b' }])).toThrow(
      /不在已实现的子集里/
    );
  });

  it('路径不存在时抛异常', () => {
    expect(() =>
      applyJsonPatch(baseChart(), [{ op: 'add', path: '/chart/nope/deep/-', value: 1 }])
    ).toThrow(/路径不存在/);
  });

  it('数组索引越界时抛异常', () => {
    expect(() =>
      applyJsonPatch(baseChart(), [{ op: 'add', path: `${CHART_ROWS_PATH}/99`, value: [9, 9] }])
    ).toThrow(/越界/);
  });
});

describe('detectRowAppend', () => {
  it('全是往 rows 末尾追加 → 认得快路径', () => {
    const ops: JsonPatchOp[] = [
      { op: 'add', path: `${CHART_ROWS_PATH}/-`, value: [3, 148] },
      { op: 'add', path: `${CHART_ROWS_PATH}/-`, value: [4, 136] },
    ];
    const result = detectRowAppend(ops);
    expect(result.isPlainAppend).toBe(true);
    expect(result.rows).toEqual([
      [3, 148],
      [4, 136],
    ]);
  });

  it('混了别的操作 → 不认，退回全量', () => {
    const ops: JsonPatchOp[] = [
      { op: 'add', path: `${CHART_ROWS_PATH}/-`, value: [3, 148] },
      { op: 'replace', path: '/chart/kind', value: 'bar' },
    ];
    expect(detectRowAppend(ops).isPlainAppend).toBe(false);
  });

  it('往数组中间插入（不是末尾）→ 不认', () => {
    // 中间插入会改变后续所有点的下标，appendData 语义上做不到
    expect(
      detectRowAppend([{ op: 'add', path: `${CHART_ROWS_PATH}/1`, value: [9, 9] }]).isPlainAppend
    ).toBe(false);
  });

  it('空补丁 → 不认', () => {
    expect(detectRowAppend([]).isPlainAppend).toBe(false);
  });

  it('追加的值不是数组 → 不认', () => {
    expect(
      detectRowAppend([{ op: 'add', path: `${CHART_ROWS_PATH}/-`, value: 42 }]).isPlainAppend
    ).toBe(false);
  });

  it('别的路径的追加 → 不认', () => {
    expect(
      detectRowAppend([{ op: 'add', path: '/chart/other/-', value: [1, 2] }]).isPlainAppend
    ).toBe(false);
  });
});

/**
 * 图元增删的识别。
 *
 * `detectDiagramPatch` 决定"改图"是走**增量**（`createSymbol` / `designer.remove`，
 * 图层不重建、视口不重置）还是退全量重建。判错的后果分两种，都不轻：
 * - **漏认**（该增量却退全量）：结果还对，只是白重建一次、用户的缩放位置被冲掉；
 * - **错认**（该退全量却走增量）：图会**静静地少画或多画东西**。
 *
 * 第二种才是要穷举的原因，所以下面每一条"不认"的分支都比"认"的分支更重要。
 */
describe('detectDiagramPatch', () => {
  const baseDoc = () => ({
    diagram: {
      kind: 'water-process',
      viewport: { focus: ['a', 'b'] },
      units: [
        { id: 'a', kind: 'inlet', name: 'A', tag: 'A-1', left: 0, top: 0 },
        { id: 'b', kind: 'pump', name: 'B', tag: 'B-1', left: 100, top: 0 },
        { id: 'c', kind: 'outlet', name: 'C', tag: 'C-1', left: 200, top: 0 },
      ],
      pipes: [
        { id: 'p-ab', sourceId: 'a', targetId: 'b', medium: 'sewage', dn: 'DN100' },
        { id: 'p-bc', sourceId: 'b', targetId: 'c', medium: 'sewage', dn: 'DN100' },
      ],
    },
  });

  it('往 units / pipes 末尾追加 → 认，且带上要新增的图元', () => {
    const unit = { id: 'd', kind: 'pump', name: 'D', tag: 'D-1', left: 300, top: 0 };
    const pipe = { id: 'p-cd', sourceId: 'c', targetId: 'd', medium: 'sewage', dn: 'DN100' };
    const hit = detectDiagramPatch(
      [
        { op: 'add', path: '/diagram/units/-', value: unit },
        { op: 'add', path: '/diagram/pipes/-', value: pipe },
      ],
      baseDoc()
    );
    expect(hit.isElementPatch).toBe(true);
    expect(hit.units).toEqual([unit]);
    expect(hit.pipes).toEqual([pipe]);
    expect(hit.removedUnitIds).toEqual([]);
    expect(hit.removedPipeIds).toEqual([]);
  });

  it('★ remove 的**下标**要靠补丁前的文档翻成 id', () => {
    // JSON Patch 只给下标，所以"删的是谁"必须查旧文档。查错文档 = 删错东西。
    const hit = detectDiagramPatch([{ op: 'remove', path: '/diagram/units/1' }], baseDoc());
    expect(hit.isElementPatch).toBe(true);
    expect(hit.removedUnitIds).toEqual(['b']);
  });

  it('★ 没有补丁前的文档 → 不认（宁可贵一点，也不能删错）', () => {
    expect(detectDiagramPatch([{ op: 'remove', path: '/diagram/units/1' }], null).isElementPatch).toBe(
      false
    );
    expect(detectDiagramPatch([{ op: 'remove', path: '/diagram/units/1' }], undefined).isElementPatch).toBe(
      false
    );
  });

  it('★ 下标越界 → 不认（不能让它静默删掉别的）', () => {
    const hit = detectDiagramPatch([{ op: 'remove', path: '/diagram/units/99' }], baseDoc());
    expect(hit.isElementPatch).toBe(false);
  });

  it('★ 增删混着别的路径 → 整批不认（宁可退全量）', () => {
    const hit = detectDiagramPatch(
      [
        { op: 'add', path: '/diagram/units/-', value: { id: 'd' } },
        { op: 'replace', path: '/diagram/title', value: '改了个标题' },
      ],
      baseDoc()
    );
    expect(hit.isElementPatch).toBe(false);
  });

  it('★ replace 一个图元 → 不认（那是"改"不是"增删"，语义不同）', () => {
    const hit = detectDiagramPatch(
      [{ op: 'replace', path: '/diagram/units/0', value: { id: 'a' } }],
      baseDoc()
    );
    expect(hit.isElementPatch).toBe(false);
  });

  it('往数组**中间**插 → 不认（那是"顺序变了"，不是"新增了"）', () => {
    const hit = detectDiagramPatch(
      [{ op: 'add', path: '/diagram/units/1', value: { id: 'x' } }],
      baseDoc()
    );
    expect(hit.isElementPatch).toBe(false);
  });

  it('追加的值不是对象（比如数字 / 数组）→ 不认', () => {
    for (const value of [42, 'x', null, [1, 2]]) {
      const hit = detectDiagramPatch([{ op: 'add', path: '/diagram/units/-', value }], baseDoc());
      expect({ value, ok: hit.isElementPatch }).toEqual({ value, ok: false });
    }
  });

  it('空补丁 / 缺 path → 不认', () => {
    expect(detectDiagramPatch([], baseDoc()).isElementPatch).toBe(false);
    expect(detectDiagramPatch([{ op: 'add' } as JsonPatchOp], baseDoc()).isElementPatch).toBe(false);
  });

  it('一条都没有效操作 → 不认（避免"认了但什么也不做"这种空转）', () => {
    expect(detectDiagramPatch([], baseDoc()).isElementPatch).toBe(false);
  });

  it('★ 删除 + 新增可以同批（改图的常态：拆一处、接一处）', () => {
    const hit = detectDiagramPatch(
      [
        { op: 'remove', path: '/diagram/pipes/0' },
        { op: 'add', path: '/diagram/pipes/-', value: { id: 'p-ac', sourceId: 'a', targetId: 'c' } },
      ],
      baseDoc()
    );
    expect(hit.isElementPatch).toBe(true);
    expect(hit.removedPipeIds).toEqual(['p-ab']);
    expect(hit.pipes).toHaveLength(1);
  });

  it('★ 认了之后 applyJsonPatch 的结果必须自洽（管线不悬空）', () => {
    // 这条盯的是"补丁要表达完整意图"：删单元必须连带删它的管线，
    // 否则文档里会留下指向不存在单元的管线（本仓的守卫会当场报错）。
    const doc = baseDoc();
    const pipeIds = doc.diagram.pipes
      .filter((p) => p.sourceId === 'b' || p.targetId === 'b')
      .map((p) => p.id);
    const ops: JsonPatchOp[] = [
      // 降序删（`remove` 之后下标会前移）
      ...doc.diagram.pipes
        .map((p, i) => ({ id: p.id, i }))
        .filter((x) => pipeIds.indexOf(x.id) >= 0)
        .sort((a, b) => b.i - a.i)
        .map((x) => ({ op: 'remove' as const, path: `/diagram/pipes/${x.i}` })),
      { op: 'remove', path: '/diagram/units/1' },
    ];
    const hit = detectDiagramPatch(ops, doc);
    expect(hit.isElementPatch).toBe(true);

    const next = applyJsonPatch(doc, ops);
    expect(next.diagram.units.map((u: any) => u.id)).toEqual(['a', 'c']);
    expect(next.diagram.pipes).toEqual([]);
    // 没有悬空引用
    const ids = new Set(next.diagram.units.map((u: any) => u.id));
    for (const p of next.diagram.pipes as any[]) {
      expect(ids.has(p.sourceId) && ids.has(p.targetId)).toBe(true);
    }
  });
});
