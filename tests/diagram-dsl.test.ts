/**
 * 图 DSL 的校验与编译（纯逻辑，node 环境，不碰 DOM / ICE）。
 *
 * 重点覆盖两件容易错的事：
 * 1. **kind-first 的分派**：未知 kind / 未知符号种类 / 未知介质都要被挡下并给出可据以修正的诊断
 *    （自修复回路靠这个文本回灌给 agent）；
 * 2. **端口兜底**：不写端口时必须是 `R → L` 而**不是**引擎的 `B → T`。
 *    案例数据 37 条管线里有 28 条没写端口，这条错了整张图的走向就变了。
 */
import { compileDiagramDsl, countOps, DEFAULT_SOURCE_PORT, DEFAULT_TARGET_PORT } from '../src/domain/diagram/compile';
import {
  formatDiagramDiagnostics,
  validateDiagramDsl,
} from '../src/domain/diagram/validate';
import { SYMBOL_KINDS, MEDIUM_STYLES } from '../src/domain/diagram/types';
import type { WaterProcessDslDocument } from '../shared/diagram';

/** 一份最小可用文档：两个单元 + 一条管线。 */
function minimal(overrides: Partial<WaterProcessDslDocument> = {}): WaterProcessDslDocument {
  return {
    kind: 'water-process',
    units: [
      { id: 'inlet', kind: 'inlet', name: '厂外进水', tag: 'IN', left: 30, top: 120 },
      { id: 'pump', kind: 'pump', name: '进水泵', tag: 'P-101', left: 130, top: 128 },
    ],
    pipes: [{ id: 'p1', sourceId: 'inlet', targetId: 'pump', medium: 'sewage', dn: 'DN800' }],
    ...overrides,
  };
}

/** 取诊断里的所有 message，拼起来方便断言子串。 */
function messages(result: ReturnType<typeof validateDiagramDsl>): string {
  return [...result.errors, ...result.warnings].map((d) => `${d.path} ${d.message}`).join('\n');
}

describe('图 DSL 校验：白名单来自上游包', () => {
  it('31 种符号 / 9 种介质是从 ice-entity-designer 转发的，不是本仓复制的一张表', () => {
    // 转发的意义：上游加一种符号，本仓不用改就认。这里断言"确实取到了上游那份"。
    expect(SYMBOL_KINDS.length).toBe(31);
    expect(Object.keys(MEDIUM_STYLES).sort()).toEqual(
      ['air', 'chemical', 'effluent', 'power', 'recycle', 'returnSludge', 'sewage', 'signal', 'sludge'].sort()
    );
  });
});

describe('图 DSL 校验', () => {
  it('最小可用文档通过，且没有警告以外的噪音', () => {
    const result = validateDiagramDsl(minimal());
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('载荷根本不是对象 → 报错且不崩', () => {
    for (const bad of [undefined, null, 42, 'x', []]) {
      const result = validateDiagramDsl(bad);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('缺 kind / 未知 kind → 在 kind 上就停住，不继续往下报一串噪声', () => {
    const missing = validateDiagramDsl({ units: [], pipes: [] });
    expect(missing.valid).toBe(false);
    expect(missing.errors).toHaveLength(1);
    expect(missing.errors[0].path).toBe('kind');

    const unknown = validateDiagramDsl({ kind: 'flowchart', units: [], pipes: [] });
    expect(unknown.valid).toBe(false);
    expect(unknown.errors[0].message).toContain('未知的 kind');
  });

  it('未知符号种类 → 报错并列出合法值（诊断要可据以修正）', () => {
    const doc = minimal({
      units: [{ id: 'x', kind: 'notASymbol', left: 0, top: 0 }],
      pipes: [],
    });
    const result = validateDiagramDsl(doc);
    expect(result.valid).toBe(false);
    const msg = messages(result);
    expect(msg).toContain('units[0].kind');
    expect(msg).toContain('未知的符号种类');
    expect(msg).toContain('barScreen'); // 合法值被列出来了
  });

  it('未知介质 → 报错并列出合法介质', () => {
    const doc = minimal({
      pipes: [{ id: 'p1', sourceId: 'inlet', targetId: 'pump', medium: 'plasma' }],
    });
    const result = validateDiagramDsl(doc);
    expect(result.valid).toBe(false);
    expect(messages(result)).toContain('未知的介质');
  });

  it('id 重复 → 报错并指出第一次出现的位置', () => {
    const doc = minimal({
      units: [
        { id: 'dup', kind: 'pump', left: 0, top: 0 },
        { id: 'dup', kind: 'pump', left: 10, top: 0 },
      ],
      pipes: [],
    });
    const result = validateDiagramDsl(doc);
    expect(result.valid).toBe(false);
    const msg = messages(result);
    expect(msg).toContain('units[1].id');
    expect(msg).toContain('重复');
    expect(msg).toContain('units[0]');
  });

  it('管线端点不存在 → 报错（这正是 createPipe 会抛的那个错，要提前挡下）', () => {
    const doc = minimal({
      pipes: [{ id: 'p1', sourceId: 'inlet', targetId: 'ghost', medium: 'sewage' }],
    });
    const result = validateDiagramDsl(doc);
    expect(result.valid).toBe(false);
    const msg = messages(result);
    expect(msg).toContain('pipes[0].targetId');
    expect(msg).toContain('ghost');
  });

  it('组件 id 全局唯一：管线不能与单元重名', () => {
    const doc = minimal({
      pipes: [{ id: 'inlet', sourceId: 'inlet', targetId: 'pump', medium: 'sewage' }],
    });
    const result = validateDiagramDsl(doc);
    expect(result.valid).toBe(false);
    expect(messages(result)).toContain('重名');
  });

  it('非法端口 → 报错', () => {
    const doc = minimal({
      pipes: [{ id: 'p1', sourceId: 'inlet', targetId: 'pump', medium: 'sewage', sourcePort: 'X' as any }],
    });
    const result = validateDiagramDsl(doc);
    expect(result.valid).toBe(false);
    expect(messages(result)).toContain('非法端口');
  });

  it('坐标不是有穷数 / 量级离谱 → 报错', () => {
    const nan = validateDiagramDsl(
      minimal({ units: [{ id: 'a', kind: 'pump', left: NaN, top: 0 }], pipes: [] })
    );
    expect(nan.valid).toBe(false);
    expect(messages(nan)).toContain('有穷数字');

    const huge = validateDiagramDsl(
      minimal({ units: [{ id: 'a', kind: 'pump', left: 1e9, top: 0 }], pipes: [] })
    );
    expect(huge.valid).toBe(false);
    expect(messages(huge)).toContain('超出合理范围');
  });

  it('多写的字段 → 警告而不是错误（指出被忽略的键，避免 agent 以为表达成功了）', () => {
    const doc = minimal({
      units: [{ id: 'a', kind: 'pump', left: 0, top: 0, color: 'red' } as any],
      pipes: [],
    });
    const result = validateDiagramDsl(doc);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((d) => d.message.includes('color'))).toBe(true);
  });

  it('孤立单元 → 警告（可能漏了管线，也可能本来就该独立）', () => {
    const doc = minimal({
      units: [
        { id: 'inlet', kind: 'inlet', left: 0, top: 0 },
        { id: 'pump', kind: 'pump', left: 100, top: 0 },
        { id: 'lonely', kind: 'blower', left: 200, top: 0 },
      ],
    });
    const result = validateDiagramDsl(doc);
    expect(result.valid).toBe(true);
    expect(messages(result)).toContain('孤岛');
  });

  it('诊断条数有上限：一份全错的载荷不会产出几十行文本', () => {
    const units = Array.from({ length: 50 }, (_, i) => ({ id: `u${i}`, kind: 'bogus', left: 0, top: 0 }));
    const result = validateDiagramDsl({ kind: 'water-process', units, pipes: [] });
    expect(result.errors.length).toBeLessThanOrEqual(8);
  });

  it('formatDiagramDiagnostics：无诊断返回 null，有诊断返回多行文本', () => {
    expect(formatDiagramDiagnostics({ valid: true, errors: [], warnings: [] })).toBeNull();
    const text = formatDiagramDiagnostics(validateDiagramDsl({ kind: 'nope' }));
    expect(text).toContain('[错误]');
    expect(text!.split('\n').length).toBeGreaterThan(0);
  });
});

describe('图 DSL 编译', () => {
  it('先全部 symbol、再全部 pipe（createPipe 要求端点已存在）', () => {
    const doc = minimal({
      units: [
        { id: 'a', kind: 'inlet', left: 0, top: 0 },
        { id: 'b', kind: 'pump', left: 10, top: 0 },
        { id: 'c', kind: 'outlet', left: 20, top: 0 },
      ],
      pipes: [
        { id: 'p1', sourceId: 'a', targetId: 'b', medium: 'sewage' },
        { id: 'p2', sourceId: 'b', targetId: 'c', medium: 'effluent' },
      ],
    });
    const ops = compileDiagramDsl(doc);
    expect(ops.map((o) => o.op)).toEqual(['symbol', 'symbol', 'symbol', 'pipe', 'pipe']);
    expect(countOps(ops)).toEqual({ symbols: 3, pipes: 2 });
  });

  it('★ 端口兜底是 R → L，不是引擎默认的 B → T', () => {
    const ops = compileDiagramDsl(minimal());
    const pipe = ops.find((o) => o.op === 'pipe') as any;
    expect(pipe.sourcePort).toBe(DEFAULT_SOURCE_PORT);
    expect(pipe.targetPort).toBe(DEFAULT_TARGET_PORT);
    // 钉死字面量：改兜底值必须是有意识的改动，而不是顺手
    expect(DEFAULT_SOURCE_PORT).toBe('R');
    expect(DEFAULT_TARGET_PORT).toBe('L');
    // 并且明确不是引擎的那两个默认值
    expect([pipe.sourcePort, pipe.targetPort]).not.toEqual(['B', 'T']);
  });

  it('写了的端口不被兜底覆盖', () => {
    const doc = minimal({
      pipes: [
        { id: 'p1', sourceId: 'inlet', targetId: 'pump', medium: 'sewage', sourcePort: 'B', targetPort: 'T' },
      ],
    });
    const pipe = compileDiagramDsl(doc).find((o) => o.op === 'pipe') as any;
    expect([pipe.sourcePort, pipe.targetPort]).toEqual(['B', 'T']);
  });

  it('省略的 name / tag / dn 归一成空串（不让 undefined 流到引擎）', () => {
    const ops = compileDiagramDsl(
      minimal({
        units: [{ id: 'a', kind: 'pump', left: 0, top: 0 }],
        pipes: [{ id: 'p1', sourceId: 'a', targetId: 'a', medium: 'sewage' }],
      })
    );
    const symbol = ops.find((o) => o.op === 'symbol') as any;
    const pipe = ops.find((o) => o.op === 'pipe') as any;
    expect([symbol.name, symbol.tag]).toEqual(['', '']);
    expect(pipe.dn).toBe('');
  });

  it('无 pipes / 无 units 时不崩（校验层负责报错，编译层只管不炸）', () => {
    expect(countOps(compileDiagramDsl({ kind: 'water-process', units: [], pipes: [] } as any))).toEqual({
      symbols: 0,
      pipes: 0,
    });
    expect(countOps(compileDiagramDsl({ kind: 'water-process' } as any))).toEqual({ symbols: 0, pipes: 0 });
  });
});
