/**
 * 翻译层的两个纯函数，外加一处**对上游契约的集成断言**。
 *
 * 后半部分（`validateChartDsl` 的诊断）测的是 ICE 的行为而不是我们的——
 * 之所以还放在这儿，是因为这是自修复回路的**前提**：如果上游的诊断不再带
 * "可用列名"这类可操作信息，回灌给模型的文本就没用了，整条回路会退化成
 * "报了个错但没人知道怎么改"。所以它值得一条会红的测试盯着。
 */
import { compileChartDsl, validateChartDsl } from '@damoqiongqiu/ice-chart-dsl';
import { planAppend, withRoundTripInteractions } from '../src/domain/ice/option-mapping';

const numericOption = () => ({
  xAxis: { type: 'value', name: '秒' },
  series: [
    { id: 'series-1', name: '吞吐', data: [[1, 92], [2, 105]] },
  ],
});

const categoryOption = () => ({
  xAxis: { type: 'category', name: '月份', data: ['1月', '2月'] },
  series: [
    { id: 'series-1', name: '线上', data: [120, 132] },
    { id: 'series-2', name: '线下', data: [86, 96] },
  ],
});

describe('planAppend', () => {
  it('数值轴上的单系列追加走快路径', () => {
    const plan = planAppend(numericOption(), [[3, 148], [4, 136]]);
    expect(plan).toEqual([{ seriesId: 'series-1', points: [[3, 148], [4, 136]] }]);
  });

  it('类目轴一律退回全量（appendData 不补 xAxis.data）', () => {
    // 判错不会当场报错，只会让图悄悄错位——所以这里必须有断言盯着
    expect(planAppend(categoryOption(), [['3月', 168, '线上']])).toBeNull();
  });

  it('按分组列分派到对应系列', () => {
    const option = numericOption();
    option.series = [
      { id: 'series-1', name: '线上', data: [] },
      { id: 'series-2', name: '线下', data: [] },
    ];
    const plan = planAppend(option, [
      [3, 168, '线上'],
      [3, 101, '线下'],
      [4, 142, '线上'],
    ]);
    expect(plan).toEqual([
      { seriesId: 'series-1', points: [[3, 168], [4, 142]] },
      { seriesId: 'series-2', points: [[3, 101]] },
    ]);
  });

  it('分组列找不到对应系列 → 退回全量', () => {
    const option = numericOption();
    option.series = [{ id: 'series-1', name: '线上', data: [] }];
    expect(planAppend(option, [[3, 168, '不存在']])).toBeNull();
  });

  it('行太短 / 空行表 / 没有系列 都退回全量', () => {
    expect(planAppend(numericOption(), [[3]])).toBeNull();
    expect(planAppend(numericOption(), [])).toBeNull();
    expect(planAppend({ xAxis: { type: 'value' }, series: [] }, [[3, 1]])).toBeNull();
  });

  it('多个 x 轴时，任一为类目轴就退回全量', () => {
    const option = numericOption();
    option.xAxis = [{ type: 'value' }, { type: 'category' }] as any;
    expect(planAppend(option, [[3, 1]])).toBeNull();
  });
});

describe('withRoundTripInteractions', () => {
  it('注入点击 / 框选 / 悬停的上行开关', () => {
    const option = withRoundTripInteractions({ series: [] });
    expect(option.interaction.hover.enabled).toBe(true);
    expect(option.interaction.select.enabled).toBe(true);
    expect(option.interaction.brush).toMatchObject({ enabled: true, axes: 'x', mode: 'select' });
  });

  it('DSL 自己指定的 interaction 优先级更高', () => {
    const option = withRoundTripInteractions({
      series: [],
      interaction: { brush: { enabled: false }, keyboard: true },
    });
    expect(option.interaction.brush.enabled).toBe(false);
    expect(option.interaction.keyboard).toBe(true);
  });

  it('不改动入参', () => {
    const input = { series: [] };
    withRoundTripInteractions(input);
    expect(input).toEqual({ series: [] });
  });
});

describe('上游契约：ice-chart-dsl 的诊断可操作性', () => {
  const good = {
    schemaVersion: 1,
    kind: 'bar' as const,
    data: { columns: ['月份', '销量', '渠道'], rows: [['1月', 120, '线上']] },
    encoding: { x: '月份', y: '销量', series: '渠道' },
  };

  it('正常 DSL 编译成 ChartOption', () => {
    const option = compileChartDsl(good) as any;
    expect(option.series.length).toBeGreaterThan(0);
    expect(option.xAxis.type).toBe('category');
  });

  it('列名写错时报错，并**列出可用列名**（自修复回路的前提）', () => {
    const broken = { ...good, encoding: { x: '月份', y: '销售额', series: '渠道' } };
    const result = validateChartDsl(broken);
    expect(result.valid).toBe(false);
    const text = result.errors.map((e) => e.message).join('\n');
    // 光说"列不存在"没用，必须带上"可用的是哪些"，回灌给模型才有修复依据
    expect(text).toContain('销售额');
    expect(text).toContain('销量');
  });

  it('任何垃圾输入都不抛异常（它是给 agent 用的反馈通道）', () => {
    for (const junk of [null, undefined, 42, 'x', [], { kind: '不存在' }]) {
      expect(() => validateChartDsl(junk as any)).not.toThrow();
      expect(validateChartDsl(junk as any).valid).toBe(false);
    }
  });
});
