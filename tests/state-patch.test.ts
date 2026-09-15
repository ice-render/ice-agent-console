/**
 * JSON Patch 子集 + "这批补丁是不是单纯追加行"的识别。
 *
 * `detectRowAppend` 决定了前端走 `appendData` 快路径还是全量重绘——
 * 判错的后果是**图看着对但内部状态错了**，这类 bug 最难发现，所以边界要穷举。
 */
import {
  CHART_ROWS_PATH,
  applyJsonPatch,
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
