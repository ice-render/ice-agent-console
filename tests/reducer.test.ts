/**
 * 事件归约器。
 *
 * 这里要断言的几件事都是前面讨论定下来的设计约束：
 *   - 未知事件被丢弃而不是崩（协议要求的容错口径）
 *   - 文本 / 工具参数是**流式拼接**的
 *   - 快照是**替换**语义，增量是**打补丁**
 *   - 「指着讲」的效果以 effect 形式吐出来，reducer 自己不碰 canvas
 */
import { EventType } from '@ag-ui/core';
import {
  initialState,
  reduce,
  reduceAll,
  type Action,
  type Effect,
  type TextItem,
  type ToolItem,
} from '../src/domain/agui/reducer';
import { CHART_ROWS_PATH } from '../src/domain/agui/state-patch';
import { EVT_POINT_AT, EVT_POINT_CLEAR, EVT_ZOOM } from '../shared/contract';

/** 折叠一串动作，顺便收集所有 effect。 */
function run(actions: Action[]) {
  let state = initialState('t1');
  const effects: Effect[] = [];
  for (const action of actions) {
    const result = reduce(state, action);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

const chartDsl = (rows: any[][]) => ({
  chart: { kind: 'line', data: { columns: ['秒', '吞吐'], rows }, encoding: { x: '秒', y: '吞吐' } },
});

/** 一份最小的图 DSL（图元增删的用例用它当基准）。 */
const diagramDsl = () => ({
  kind: 'water-process',
  units: [
    { id: 'a', kind: 'inlet', name: 'A', tag: 'A-1', left: 0, top: 0 },
    { id: 'b', kind: 'pump', name: 'B', tag: 'B-1', left: 10, top: 0 },
  ],
  pipes: [{ id: 'p-ab', sourceId: 'a', targetId: 'b', medium: 'sewage', dn: 'DN100' }],
});

describe('生命周期', () => {
  it('RUN_STARTED 进入运行态并把 runId 记下来', () => {
    const { state } = run([{ type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' }]);
    expect(state.status).toBe('running');
    expect(state.runId).toBe('r1');
  });

  it('RUN_FINISHED 回到空闲', () => {
    const { state } = run([
      { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' },
      { type: EventType.RUN_FINISHED, threadId: 't1', runId: 'r1' },
    ]);
    expect(state.status).toBe('idle');
  });

  it('RUN_ERROR 进入错误态并带上消息', () => {
    const { state } = run([{ type: EventType.RUN_ERROR, message: '炸了' }]);
    expect(state.status).toBe('error');
    expect(state.error).toBe('炸了');
  });

  it('新一轮开始时清掉上一轮的诊断', () => {
    // 不清的话诊断会一直挂在 context 上，让 agent 以为每轮都有错
    const { state } = run([
      { type: '@local/diagnostics', text: '列不存在' },
      { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' },
    ]);
    expect(state.diagnostics).toBeNull();
  });
});

describe('文本流式', () => {
  it('START / CONTENT / END 拼出一段文字', () => {
    const { state } = run([
      { type: EventType.TEXT_MESSAGE_START, messageId: 'm1', role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: '你' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: '好' },
      { type: EventType.TEXT_MESSAGE_END, messageId: 'm1' },
    ]);
    const item = state.items[0] as TextItem;
    expect(item.text).toBe('你好');
    expect(item.done).toBe(true);
  });

  it('没收到 START 就来 CONTENT 也不丢内容', () => {
    const { state } = run([{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'mX', delta: 'hi' }]);
    expect((state.items[0] as TextItem).text).toBe('hi');
  });

  it('多段文字按顺序落位', () => {
    const { state } = run([
      { type: EventType.TEXT_MESSAGE_START, messageId: 'm1', role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'A' },
      { type: EventType.TEXT_MESSAGE_END, messageId: 'm1' },
      { type: EventType.TEXT_MESSAGE_START, messageId: 'm2', role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm2', delta: 'B' },
      { type: EventType.TEXT_MESSAGE_END, messageId: 'm2' },
    ]);
    expect(state.items.map((i) => (i as TextItem).text)).toEqual(['A', 'B']);
  });
});

describe('工具调用流式', () => {
  it('参数分片拼起来后在 END 时解析出 DSL', () => {
    const dsl = { kind: 'bar' };
    const json = JSON.stringify(dsl);
    const { state, effects } = run([
      { type: EventType.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'render_chart' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: json.slice(0, 5) },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: json.slice(5) },
      { type: EventType.TOOL_CALL_END, toolCallId: 'tc1' },
    ]);
    const item = state.items[0] as ToolItem;
    expect(item.argsRaw).toBe(json);
    expect(item.dsl).toEqual(dsl);
    expect(effects).toEqual([{ type: 'mount-chart', toolCallId: 'tc1', dsl }]);
  });

  it('参数是半截 JSON 时不抛异常，留下 parseError', () => {
    // 模型吐半截 JSON 很常见，整条流不能因此挂掉
    const { state, effects } = run([
      { type: EventType.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'render_chart' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: '{"kind":' },
      { type: EventType.TOOL_CALL_END, toolCallId: 'tc1' },
    ]);
    const item = state.items[0] as ToolItem;
    expect(item.dsl).toBeUndefined();
    expect(item.parseError).toBeTruthy();
    expect(effects).toEqual([]);
  });

  it('结果事件把状态推到 result', () => {
    const { state } = run([
      { type: EventType.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'render_chart' },
      { type: EventType.TOOL_CALL_RESULT, toolCallId: 'tc1', content: 'rendered' },
    ]);
    expect((state.items[0] as ToolItem).status).toBe('result');
  });
});

describe('状态同步', () => {
  it('快照是替换语义', () => {
    const { state } = run([
      { type: EventType.STATE_SNAPSHOT, snapshot: chartDsl([[1, 10]]) },
      { type: EventType.STATE_SNAPSHOT, snapshot: chartDsl([[2, 20]]) },
    ]);
    expect(state.sharedState.chart.data.rows).toEqual([[2, 20]]);
  });

  it('增量打补丁，且纯追加时吐 append-rows 快路径', () => {
    const { state, effects } = run([
      { type: EventType.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'render_chart' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: '{"kind":"line"}' },
      { type: EventType.TOOL_CALL_END, toolCallId: 'tc1' },
      { type: EventType.STATE_SNAPSHOT, snapshot: chartDsl([[1, 10]]) },
      {
        type: EventType.STATE_DELTA,
        delta: [{ op: 'add', path: `${CHART_ROWS_PATH}/-`, value: [2, 20] }],
      },
    ]);
    expect(state.sharedState.chart.data.rows).toEqual([[1, 10], [2, 20]]);
    expect(effects).toContainEqual({ type: 'append-rows', toolCallId: 'tc1', rows: [[2, 20]] });
  });

  it('非纯追加的补丁退回全量重绘', () => {
    const { effects } = run([
      { type: EventType.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'render_chart' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: '{"kind":"line"}' },
      { type: EventType.TOOL_CALL_END, toolCallId: 'tc1' },
      { type: EventType.STATE_SNAPSHOT, snapshot: chartDsl([[1, 10]]) },
      {
        type: EventType.STATE_DELTA,
        delta: [{ op: 'replace', path: '/chart/kind', value: 'bar' }],
      },
    ]);
    expect(effects.some((e) => e.type === 'mount-chart')).toBe(true);
    expect(effects.some((e) => e.type === 'append-rows')).toBe(false);
  });

  it('★ 全量回退时传的是**那一层自己的 DSL**，不是整份 state', () => {
    // 回归：这里以前把 `patched`（整份 state，形如 `{chart: {...}}`）当 dsl 传下去，
    // 视图层的校验器会拦下来 —— 症状是"补丁一来图就变成一张报错的空卡"。
    // 这条路径原来没有用例走过，是加图元增删时才发现的。
    const { effects } = run([
      { type: EventType.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'render_chart' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: '{"kind":"line"}' },
      { type: EventType.TOOL_CALL_END, toolCallId: 'tc1' },
      { type: EventType.STATE_SNAPSHOT, snapshot: chartDsl([[1, 10]]) },
      { type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/chart/kind', value: 'bar' }] },
    ]);
    // ⚠️ 取**最后一条**：`TOOL_CALL_END` 也会吐一条 mount-chart（用解析出来的参数），
    //    而这里要看的是 `STATE_DELTA` 那条。用 `find` 会拿到前面那条，测不到东西。
    const mounts = effects.filter((e) => e.type === 'mount-chart') as any[];
    const mount = mounts[mounts.length - 1];
    expect(mount.dsl).toEqual({
      kind: 'bar',
      data: { columns: ['秒', '吞吐'], rows: [[1, 10]] },
      encoding: { x: '秒', y: '吞吐' },
    });
    expect(mount.dsl.chart).toBeUndefined();
  });

  it('★ 图元增删走 `patch-diagram`（增量），不退回全量重建', () => {
    const { state, effects } = run([
      { type: EventType.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'render_diagram' },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: 'tc1',
        delta: JSON.stringify(diagramDsl()),
      },
      { type: EventType.TOOL_CALL_END, toolCallId: 'tc1' },
      { type: EventType.STATE_SNAPSHOT, snapshot: { diagram: diagramDsl() } },
      {
        type: EventType.STATE_DELTA,
        delta: [
          { op: 'add', path: '/diagram/units/-', value: { id: 'ozone', kind: 'storageTank' } },
          { op: 'add', path: '/diagram/pipes/-', value: { id: 'p-xy', sourceId: 'x', targetId: 'y' } },
          { op: 'remove', path: '/diagram/units/1' },
        ],
      },
    ]);

    // 2 个 - 删掉 index 1（`b`）+ 追加 1 个 = 2 个，剩下 a 与 ozone。
    // 注意 `remove` 的 index 是**补丁前**那份文档里的下标 —— 这一条成立的前提是
    // `detectDiagramPatch` 只认"往末尾追加"（那种 add 不会让已有元素的下标前移）。
    expect(state.sharedState.diagram.units.map((u: any) => u.id)).toEqual(['a', 'ozone']);
    const patch = effects.find((e) => e.type === 'patch-diagram') as any;
    expect(patch).toBeTruthy();
    expect(patch.units).toEqual([{ id: 'ozone', kind: 'storageTank' }]);
    expect(patch.pipes).toEqual([{ id: 'p-xy', sourceId: 'x', targetId: 'y' }]);
    // 下标 1 → 查**补丁前**那份文档 → 'b'
    expect(patch.removedUnitIds).toEqual(['b']);
    expect(patch.removedPipeIds).toEqual([]);
    // 关键：没有退化成重建。
    // ⚠️ 判据是**条数**而不是"有没有" —— `TOOL_CALL_END` 本身就会吐一条 mount-chart，
    //    所以"存在 mount-chart"在这里永远为真，那种断言等于没测。
    //    这一批事件里 mount-chart **只该有一条**（来自 TOOL_CALL_END）。
    expect(effects.filter((e) => e.type === 'mount-chart')).toHaveLength(1);
  });

  it('★ 图元增删的补丁落在**图表**那一层时，不误判成图元增删', () => {
    // `detectDiagramPatch` 只按路径认，所以理论上它也会认 `/diagram/...`；
    // 但目标那一层不是工艺图时（比如当前是图表），这条路径不该被走。
    const { effects } = run([
      { type: EventType.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'render_chart' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: '{"kind":"line"}' },
      { type: EventType.TOOL_CALL_END, toolCallId: 'tc1' },
      { type: EventType.STATE_SNAPSHOT, snapshot: chartDsl([[1, 10]]) },
      { type: EventType.STATE_DELTA, delta: [{ op: 'add', path: '/chart/data/rows/-', value: [3, 30] }] },
    ]);
    expect(effects.some((e) => e.type === 'patch-diagram')).toBe(false);
    expect(effects.some((e) => e.type === 'append-rows')).toBe(true);
    // 同上：图表这一层的 mount-chart 也只有 `TOOL_CALL_END` 那一条
    expect(effects.filter((e) => e.type === 'mount-chart')).toHaveLength(1);
  });

  it('补丁应用失败时进入错误态（状态分叉必须让人看见）', () => {
    const { state } = run([
      { type: EventType.STATE_SNAPSHOT, snapshot: chartDsl([[1, 10]]) },
      { type: EventType.STATE_DELTA, delta: [{ op: 'move', path: '/a', from: '/b' }] },
    ]);
    expect(state.status).toBe('error');
    expect(state.error).toMatch(/STATE_DELTA 应用失败/);
  });
});

describe('自定义事件 / 叙事', () => {
  it('point-at 递增 seq 并吐出 effect', () => {
    // seq 递增是为了让"同一个值再指一次"也能重新触发高亮
    const { state, effects } = run([
      { type: EventType.CUSTOM, name: EVT_POINT_AT, value: { value: '3月' } },
      { type: EventType.CUSTOM, name: EVT_POINT_AT, value: { value: '3月' } },
    ]);
    expect(state.pointAt).toEqual({ value: '3月', seq: 2 });
    expect(effects).toEqual([
      { type: 'point-at', value: '3月' },
      { type: 'point-at', value: '3月' },
    ]);
  });

  it('point-clear 收手', () => {
    const { state, effects } = run([
      { type: EventType.CUSTOM, name: EVT_POINT_AT, value: { value: '3月' } },
      { type: EventType.CUSTOM, name: EVT_POINT_CLEAR },
    ]);
    expect(state.pointAt).toBeNull();
    expect(effects[1]).toEqual({ type: 'clear-point' });
  });

  it('不认识的 CUSTOM 事件安静路过', () => {
    const { state, effects } = run([
      { type: EventType.CUSTOM, name: 'someone/else-entirely', value: {} },
    ]);
    expect(state.pointAt).toBeNull();
    expect(effects).toEqual([]);
    expect(state.status).toBe('idle');
  });

  it('point-at 的 blink 透传进 effect；没带就不编一个', () => {
    const withBlink = run([
      { type: EventType.CUSTOM, name: EVT_POINT_AT, value: { value: 'ana', blink: true } },
    ]);
    expect(withBlink.effects[0]).toEqual({ type: 'point-at', value: 'ana', blink: true });

    const withoutBlink = run([
      { type: EventType.CUSTOM, name: EVT_POINT_AT, value: { value: 'ana' } },
    ]);
    expect(withoutBlink.effects[0]).toEqual({ type: 'point-at', value: 'ana' });
    expect('blink' in withoutBlink.effects[0]).toBe(false);
  });

  it('zoom 递增 seq 并吐出 effect（连发两条 in 要真的放大两次）', () => {
    const { state, effects } = run([
      { type: EventType.CUSTOM, name: EVT_ZOOM, value: { direction: 'in' } },
      { type: EventType.CUSTOM, name: EVT_ZOOM, value: { direction: 'in' } },
    ]);
    expect(state.zoom).toEqual({ direction: 'in', seq: 2 });
    expect(effects).toEqual([
      { type: 'zoom', direction: 'in' },
      { type: 'zoom', direction: 'in' },
    ]);
  });

  it('zoom 的 factor / steps 原样透传，没给就不带', () => {
    const { state, effects } = run([
      { type: EventType.CUSTOM, name: EVT_ZOOM, value: { direction: 'out', factor: 1.5, steps: 3 } },
    ]);
    expect(state.zoom).toEqual({ direction: 'out', factor: 1.5, steps: 3, seq: 1 });
    expect(effects[0]).toEqual({ type: 'zoom', direction: 'out', factor: 1.5, steps: 3 });
  });

  it('zoom 的 reset 也是合法方向', () => {
    const { state, effects } = run([
      { type: EventType.CUSTOM, name: EVT_ZOOM, value: { direction: 'reset' } },
    ]);
    expect(state.zoom).toEqual({ direction: 'reset', seq: 1 });
    expect(effects[0]).toEqual({ type: 'zoom', direction: 'reset' });
  });

  it('zoom 的 `to` 是绝对倍率，带 scale', () => {
    const { state, effects } = run([
      { type: EventType.CUSTOM, name: EVT_ZOOM, value: { direction: 'to', scale: 1.5 } },
    ]);
    expect(state.zoom).toEqual({ direction: 'to', scale: 1.5, seq: 1 });
    expect(effects[0]).toEqual({ type: 'zoom', direction: 'to', scale: 1.5 });
  });

  it('★ `to` 的 scale 非法时整条丢掉（不补默认值）', () => {
    // 补默认值的后果是"视图跳到某个谁也想不到的倍率上"，比什么都不做更难查。
    // `null` 也在里面：`Number(null)` 是 0，不满足"> 0"，所以同样被挡掉。
    for (const scale of [undefined, null, 0, -1, NaN, Infinity, '']) {
      const { state, effects } = run([
        { type: EventType.CUSTOM, name: EVT_ZOOM, value: { direction: 'to', scale } },
      ]);
      expect({ scale, zoom: state.zoom }).toEqual({ scale, zoom: null });
      expect({ scale, n: effects.length }).toEqual({ scale, n: 0 });
    }
  });

  it('`to` 的数字字符串会被转成数字（与其余数值参数同一套 `Number()` 口径）', () => {
    // 不是"顺便"：JSON 里数字写成字符串很常见，而整个 reducer 对数值入参都用
    // `Number(x)` + `Number.isFinite` 这一套。这里单独钉一下，免得以后有人把它改严了
    // 反而与 `factor` / `steps` 的行为不一致。
    const { state } = run([
      { type: EventType.CUSTOM, name: EVT_ZOOM, value: { direction: 'to', scale: '1.5' } },
    ]);
    expect(state.zoom).toEqual({ direction: 'to', scale: 1.5, seq: 1 });
  });

  it('非法的缩放方向不产生 effect、也不破坏已有指令', () => {
    const { state, effects } = run([
      { type: EventType.CUSTOM, name: EVT_ZOOM, value: { direction: 'in' } },
      { type: EventType.CUSTOM, name: EVT_ZOOM, value: { direction: 'sideways' } },
      { type: EventType.CUSTOM, name: EVT_ZOOM, value: undefined },
      { type: EventType.CUSTOM, name: EVT_ZOOM, value: { direction: 'to' } },
    ]);
    // 只有第一条生效；后三条当没来过
    expect(state.zoom).toEqual({ direction: 'in', seq: 1 });
    expect(effects).toHaveLength(1);
  });

  it('缩放不会被 point-at 的 seq 影响，反之亦然（两条通道各记各的）', () => {
    const { state } = run([
      { type: EventType.CUSTOM, name: EVT_POINT_AT, value: { value: 'ana' } },
      { type: EventType.CUSTOM, name: EVT_ZOOM, value: { direction: 'in' } },
      { type: EventType.CUSTOM, name: EVT_POINT_AT, value: { value: 'ana' } },
    ]);
    expect(state.pointAt).toEqual({ value: 'ana', seq: 2 });
    expect(state.zoom).toEqual({ direction: 'in', seq: 1 });
  });
});

describe('人机回环（中断与 resume）', () => {
  it('RUN_FINISHED 带 interrupt outcome → 状态是 waiting 而不是 idle', () => {
    // 协议里中断**也是** RUN_FINISHED。如果一律记成 idle，
    // 后续逻辑就会以为一切正常 —— 用户还没填表呢。
    const { state } = run([
      { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' },
      {
        type: EventType.RUN_FINISHED,
        threadId: 't1',
        runId: 'r1',
        outcome: { type: 'interrupt', interrupts: [{ id: 'i1', reason: '需要参数', message: '请确认' }] },
      },
    ]);
    expect(state.status).toBe('waiting');
    expect(state.interrupt).toEqual({ id: 'i1', reason: '需要参数', message: '请确认' });
  });

  it('多中断时取第一个', () => {
    const { state } = run([
      {
        type: EventType.RUN_FINISHED,
        threadId: 't1',
        runId: 'r1',
        outcome: {
          type: 'interrupt',
          interrupts: [
            { id: 'i1', reason: 'r1' },
            { id: 'i2', reason: 'r2' },
          ],
        },
      },
    ]);
    expect(state.interrupt?.id).toBe('i1');
  });

  it('没有 outcome（普通结束）时不进入 waiting', () => {
    const { state } = run([
      { type: EventType.RUN_FINISHED, threadId: 't1', runId: 'r1' },
    ]);
    expect(state.status).toBe('idle');
    expect(state.interrupt).toBeNull();
  });

  it('outcome 是 success 时也不进入 waiting', () => {
    const { state } = run([
      {
        type: EventType.RUN_FINISHED,
        threadId: 't1',
        runId: 'r1',
        outcome: { type: 'success' },
      },
    ]);
    expect(state.status).toBe('idle');
  });

  it('开新一轮 run 就把中断清掉（协议规定的恢复方式就是开新 run）', () => {
    const { state } = run([
      {
        type: EventType.RUN_FINISHED,
        threadId: 't1',
        runId: 'r1',
        outcome: { type: 'interrupt', interrupts: [{ id: 'i1', reason: 'r' }] },
      },
      { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r2' },
    ]);
    expect(state.interrupt).toBeNull();
    expect(state.status).toBe('running');
  });

  it('表单提交：标记卡片为已提交，并清掉中断', () => {
    const { state } = run([
      { type: EventType.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'collect_input' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: '{"kind":"form"}' },
      { type: EventType.TOOL_CALL_END, toolCallId: 'tc1' },
      {
        type: EventType.RUN_FINISHED,
        threadId: 't1',
        runId: 'r1',
        outcome: { type: 'interrupt', interrupts: [{ id: 'i1', reason: 'r' }] },
      },
      { type: '@local/form-submitted', toolCallId: 'tc1' },
    ]);

    const item = state.items[0] as ToolItem;
    expect(item.submitted).toBe(true);
    expect(state.interrupt).toBeNull();
  });

  it('表单提交对不存在的 toolCallId 不报错', () => {
    const { state } = run([{ type: '@local/form-submitted', toolCallId: '不存在' }]);
    expect(state.items).toEqual([]);
  });
});

describe('容错口径', () => {
  it('协议词表外的事件被丢弃，状态不变也不崩', () => {
    const before = initialState('t1');
    const result = reduce(before, { type: 'SOME_FUTURE_EVENT_TYPE', payload: 1 });
    expect(result.state).toBe(before);
    expect(result.effects).toEqual([]);
  });

  it('eventCount 只在认识的事件上累加', () => {
    const { state } = run([
      { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' },
      { type: 'SOME_FUTURE_EVENT_TYPE' },
      { type: EventType.RUN_FINISHED, threadId: 't1', runId: 'r1' },
    ]);
    expect(state.eventCount).toBe(2);
  });
});

describe('reduceAll', () => {
  it('折叠到底的状态跟逐步 fold 一致', () => {
    const actions: Action[] = [
      { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' },
      { type: EventType.TEXT_MESSAGE_START, messageId: 'm1', role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: '好' },
      { type: EventType.TEXT_MESSAGE_END, messageId: 'm1' },
      { type: EventType.RUN_FINISHED, threadId: 't1', runId: 'r1' },
    ];
    expect(reduceAll(initialState('t1'), actions)).toEqual(run(actions).state);
  });
});
