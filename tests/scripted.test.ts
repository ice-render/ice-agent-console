/**
 * 脚本化 agent、剧本选择、以及**人机回环的 resume**。
 *
 * 这里的用例是 M2 的**安全网**：等 `LlmAgent` 接进来，`lastUserMessage` / `readDiagnostics`
 * 这些"读输入"的部分会被复用，而 `buildPlan` 会被替换。所以要把"读输入"的行为
 * 和"选剧本"的行为分别钉住——换掉一个的时候，另一个的红灯能告诉你哪里断了。
 */
import type { RunAgentInput } from '@ag-ui/core';
import { EventType } from '@ag-ui/core';
import {
  DEFAULT_PACE,
  NO_PACE,
  ScriptedAgent,
  lastUserMessage,
  readDiagnostics,
  readDiagnosticsTool,
} from '../server/agents/scripted';
import { buildPlan, resumeValues } from '../server/agents/scenarios';
import { WATER_PROCESS_DSL, UPGRADE_UNITS } from '../shared/water-process-case';
import { applyJsonPatch } from '../src/domain/agui/state-patch';
import { validateDiagramDsl } from '../src/domain/diagram/validate';
import { planToEvents, type ToolCallCardPlan } from '../server/agents/dsl-to-events';
import {
  COLLECT_INPUT_TOOL,
  DSL_DIAGNOSTICS_CONTEXT_KEY,
  DSL_TOOL_CONTEXT_KEY,
  RENDER_CHART_TOOL,
  RENDER_DIAGRAM_TOOL,
  STATE_DIAGRAM_KEY,
} from '../shared/contract';

function input(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: 't1',
    runId: 'r1',
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides,
  } as RunAgentInput;
}

/**
 * 从计划里取工具参数。类型上"纯文字计划没有 payload"，所以这里用 `?? {}` 收窄，
 * 只在断言具体字段时才用 any。
 */
const payloadOf = (plan: ReturnType<typeof buildPlan>) => (plan.payload ?? {}) as any;
/** 计划声明的工具名（纯文字计划没有）。 */
const toolOf = (plan: ReturnType<typeof buildPlan>) => (plan as ToolCallCardPlan).tool;

describe('lastUserMessage', () => {
  it('取最后一条用户消息', () => {
    const value = lastUserMessage(
      input({
        messages: [
          { id: '1', role: 'user', content: '第一句' },
          { id: '2', role: 'assistant', content: '回答' },
          { id: '3', role: 'user', content: '第二句' },
        ] as any,
      })
    );
    expect(value).toBe('第二句');
  });

  it('content 是 parts 数组时拼出文本', () => {
    const value = lastUserMessage(
      input({
        messages: [
          { id: '1', role: 'user', content: [{ type: 'text', text: '分' }, { type: 'text', text: '片' }] },
        ] as any,
      })
    );
    expect(value).toBe('分片');
  });

  it('没有用户消息时返回空串', () => {
    expect(lastUserMessage(input())).toBe('');
  });
});

describe('readDiagnostics', () => {
  it('没有诊断时返回 null', () => {
    expect(readDiagnostics(input())).toBeNull();
  });

  it('认出约定 key 的诊断', () => {
    const value = readDiagnostics(
      input({ context: [{ description: DSL_DIAGNOSTICS_CONTEXT_KEY, value: '列不存在' }] as any })
    );
    expect(value).toBe('列不存在');
  });

  it('别的 context 条目不会误判', () => {
    const value = readDiagnostics(
      input({ context: [{ description: 'ice-view-interaction', value: '{}' }] as any })
    );
    expect(value).toBeNull();
  });

  it('value 不是字符串时序列化返回', () => {
    const value = readDiagnostics(
      input({ context: [{ description: DSL_DIAGNOSTICS_CONTEXT_KEY, value: { code: 'x' } }] as any })
    );
    expect(value).toBe('{"code":"x"}');
  });
});

describe('buildPlan 剧本选择', () => {
  it('同样的说法永远选到同一个剧本（确定性是 e2e 的前提）', () => {
    const once = buildPlan({ message: '看看各渠道的月度销量', hasDiagnostics: false });
    const twice = buildPlan({ message: '看看各渠道的月度销量', hasDiagnostics: false });
    expect(once).toEqual(twice);
  });

  it('销量 → 柱状图 + 指着 3 月讲', () => {
    const plan = buildPlan({ message: '看看各渠道的月度销量', hasDiagnostics: false });
    expect(toolOf(plan)).toBe(RENDER_CHART_TOOL);
    expect(payloadOf(plan).kind).toBe('bar');
    expect(plan.beats.some((b) => b.pointAt === '3月')).toBe(true);
  });

  it('实时 → 折线 + 逐拍追加数据', () => {
    const plan = buildPlan({ message: '看一下实时吞吐量', hasDiagnostics: false });
    expect(payloadOf(plan).kind).toBe('line');
    expect(plan.beats.filter((b) => b.appendRows).length).toBe(3);
  });

  it('故意画错 → 第一次吐的是坏 DSL（列名不存在）', () => {
    const plan = buildPlan({ message: '故意画错', hasDiagnostics: false });
    expect(payloadOf(plan).encoding.y).toBe('销售额');
    expect(payloadOf(plan).data.columns).not.toContain('销售额');
  });

  it('带诊断进来 → 吐修正版，列名回到真的那一列', () => {
    const plan = buildPlan({ message: '随便说点什么', hasDiagnostics: true });
    expect(payloadOf(plan).encoding.y).toBe('销量');
    expect(payloadOf(plan).data.columns).toContain('销量');
  });

  it('诊断优先于关键词：修复轮里说什么都走修复', () => {
    const plan = buildPlan({ message: '看看各渠道的月度销量', hasDiagnostics: true });
    expect(payloadOf(plan).encoding.y).toBe('销量');
  });

  it('兜底剧本不画图', () => {
    expect(buildPlan({ message: '今天天气怎么样', hasDiagnostics: false }).payload).toBeUndefined();
  });
});

describe('图卡剧本（内置案例：污水处理工艺图）', () => {
  it('水务问法 → 图卡，而不是图表卡', () => {
    const plan = buildPlan({ message: '看看污水处理工艺图', hasDiagnostics: false });
    expect(toolOf(plan)).toBe(RENDER_DIAGRAM_TOOL);
    expect((plan as ToolCallCardPlan).stateKey).toBe(STATE_DIAGRAM_KEY);
  });

  it('载荷是一张真实厂站规模的图（78 单元 / 100 管线），且**从常量直接引**', () => {
    const plan = buildPlan({ message: '看看污水处理工艺图', hasDiagnostics: false }) as ToolCallCardPlan;
    const payload = payloadOf(plan);
    expect(payload.kind).toBe('water-process');
    // 不从数字再抄一遍：规模变化时这里应当**自动**跟着走，
    // 真正要钉的是"剧本发出去的就是那份内置案例"这件事
    expect(payload).toBe(WATER_PROCESS_DSL);
    expect(payload.units.length).toBeGreaterThanOrEqual(60);
    expect(payload.pipes.length).toBeGreaterThanOrEqual(70);
    // 两组并联的生化线都要在（这是"真实厂站"的第一条特征）
    const ids = new Set(payload.units.map((u: any) => u.id));
    for (const id of ['ana1', 'anx1', 'aer1', 'sec1', 'ana2', 'anx2', 'aer2', 'sec2']) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('★ 开场白里的规模数字**从数据现算**，不写死（曾经写死过 34/37）', () => {
    // 回归：图从 34/37 扩到两组生化并联之后，讲稿里还写着 34 个单元 ——
    // 画面上 68 个符号、嘴上说 34 个，这种"文案与数据各存一份"的漂移
    // 只会在用户看着屏幕时暴露。这里把两者钉在一起：改图必然改文案。
    const plan = buildPlan({ message: '看看污水处理工艺图', hasDiagnostics: false }) as ToolCallCardPlan;
    const payload = payloadOf(plan);
    const intro = plan.intro ?? '';
    const expected = [
      `${payload.units.length} 个单元`,
      `${payload.pipes.length} 段管线`,
      `${new Set(payload.units.map((u: any) => u.kind)).size} 种工艺符号`,
      `${new Set(payload.pipes.map((p: any) => p.medium)).size} 种介质线型`,
    ];
    for (const s of expected) expect(intro).toContain(s);
  });

  it('图卡的**标题**只描述基础图真有的东西（提标段是剧本才加的）', () => {
    // 回归：标题里曾写着"臭氧 / 活性炭 / 超滤"，而这三格在基础图里是**预留空位**，
    // 只有「提标改造」剧本会把它们插进去。标题与画面不符同样是用户一眼可见的错。
    const plan = buildPlan({ message: '看看污水处理工艺图', hasDiagnostics: false }) as ToolCallCardPlan;
    const payload = payloadOf(plan);
    const ids = new Set(payload.units.map((u: any) => u.id));
    for (const id of ['ozone', 'carbon', 'membrane']) {
      expect(ids.has(id)).toBe(false);
      expect(payload.title).not.toContain(UPGRADE_UNITS.find((u) => u.id === id)!.name);
    }
    expect(payload.title).toContain('滤布滤池');
    expect(payload.title).toContain('消毒');
  });

  it('★ 含「流」的水务问法不会被流式剧本抢走', () => {
    // 回归：水务分支必须排在 `/实时|趋势|流|…/` **之前**，
    // 否则"工艺流程"里的"流"会把这条问法判成实时吞吐量
    for (const text of ['看看工艺流程', '污水处理工艺流程', 'AAO 工艺流程图']) {
      const plan = buildPlan({ message: text, hasDiagnostics: false });
      expect(toolOf(plan)).toBe(RENDER_DIAGRAM_TOOL);
    }
    // 反向：真的问吞吐量还是要走流式剧本
    const streaming = buildPlan({ message: '看一下实时吞吐量', hasDiagnostics: false });
    expect(toolOf(streaming)).toBe(RENDER_CHART_TOOL);
  });

  it('节拍里有指着讲的单元 id，且都能在图里找到', () => {
    const plan = buildPlan({ message: '看看污水处理工艺图', hasDiagnostics: false }) as ToolCallCardPlan;
    const ids = new Set(payloadOf(plan).units.map((u: any) => u.id));
    const pointed = (plan.beats || []).map((b) => b.pointAt).filter(Boolean) as string[];
    expect(pointed.length).toBeGreaterThan(0);
    for (const id of pointed) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('「故意画错工艺图」吐的是**图**的坏 DSL（未知符号种类），不是图表的坏 DSL', () => {
    const plan = buildPlan({ message: '故意画错工艺图', hasDiagnostics: false }) as ToolCallCardPlan;
    expect(toolOf(plan)).toBe(RENDER_DIAGRAM_TOOL);
    const kinds = payloadOf(plan).units.map((u: any) => u.kind);
    expect(kinds).toContain('greaseTrap'); // 隔油池：看着合理，但不在这套 31 种符号里
  });

  it('★ 修复轮按 diagnosticsTool 吐回同一种卡片（不然图 DSL 写错会被"修"成柱状图）', () => {
    const fixedDiagram = buildPlan({
      message: '',
      hasDiagnostics: true,
      diagnosticsTool: RENDER_DIAGRAM_TOOL,
    }) as ToolCallCardPlan;
    expect(toolOf(fixedDiagram)).toBe(RENDER_DIAGRAM_TOOL);
    expect((fixedDiagram as any).payload.units.map((u: any) => u.kind)).not.toContain('greaseTrap');

    // 老客户端不发这条 → 退回图表卡（与加这条之前的行为一致）
    const fallback = buildPlan({ message: '', hasDiagnostics: true }) as ToolCallCardPlan;
    expect(toolOf(fallback)).toBe(RENDER_CHART_TOOL);
  });

  it('缩放问法 → 走缩放剧本，节拍里有 zoom 指令', () => {
    const plan = buildPlan({ message: '把工艺图放大', hasDiagnostics: false }) as ToolCallCardPlan;
    const zooms = (plan.beats || []).map((b) => b.zoom).filter(Boolean);
    expect(zooms.length).toBeGreaterThan(0);
    // 讲稿用**绝对**倍率（`to`）—— 相对倍率在十几拍的解说里会累积到不可预期。
    // 只有 `reset` 是例外：它回的是"初始视野"，没有对应的绝对数。
    expect(zooms.some((z: any) => z.direction === 'to' && z.scale > 0)).toBe(true);
    expect(zooms.some((z: any) => z.direction === 'reset')).toBe(true);
  });

  it('★ 缩放 / 闪烁剧本**不重新画图**（纯文字计划，作用在已有那张图上）', () => {
    // 这是布局反转之后定下来的一条硬规矩：水务相关的示例都作用在**那一张**图上面。
    // 违反它的症状是"想放大一下，结果又画了一遍图"（tool call 里塞 8KB DSL、
    // 对话里多一条条目、图纸上的视口被重置）—— 而没有 payload 就没有这一切。
    for (const text of ['把工艺图放大', '放大一点', '缩小', '复位', '推近看', '让图元闪烁', '闪一闪']) {
      const plan = buildPlan({ message: text, hasDiagnostics: false }) as ToolCallCardPlan;
      expect({ text, tool: toolOf(plan) }).toEqual({ text, tool: undefined });
      expect({ text, units: payloadOf(plan).units }).toEqual({ text, units: undefined });
      const beats = plan.beats || [];
      expect({ text, beats: beats.length > 0 }).toEqual({ text, beats: true });
      // 但必须真的下了命令（否则就是一段没有动作的独白）
      expect({ text, cmd: beats.some((b) => !!b.zoom || !!b.blink) }).toEqual({ text, cmd: true });
    }
  });

  it('★ 「把工艺图放大」不能被"重画一张工艺图"抢走', () => {
    // 回归：缩放分支必须排在 isWaterAsk **之前**。
    // 排后面的话这一句会被 waterProcessPlan 收走 —— 用户要点"放大"，
    // 看到的却是一张重画的图（而且这一轮根本没有 zoom 指令）。
    for (const text of ['把工艺图放大', '放大一点', '缩小', '复位', '推近看']) {
      const plan = buildPlan({ message: text, hasDiagnostics: false }) as ToolCallCardPlan;
      expect({ text, tool: toolOf(plan) }).toEqual({ text, tool: undefined });
      expect({ text, zoom: (plan.beats || []).some((b) => !!b.zoom) }).toEqual({ text, zoom: true });
    }
  });

  it('闪烁问法 → 节拍里 pointAt 带 blink', () => {
    const plan = buildPlan({ message: '让图元闪烁', hasDiagnostics: false }) as ToolCallCardPlan;
    const blinked = (plan.beats || []).filter((b) => b.blink);
    expect(blinked.length).toBeGreaterThan(0);
    // 闪的必须同时有指的地方（否则就是"闪一个没被指到的东西"）
    for (const b of blinked) {
      expect(b.pointAt).toBeDefined();
    }
  });

  it('★ 「让工艺图闪烁」也要排在 isWaterAsk 之前', () => {
    for (const text of ['让图元闪烁', '工艺图闪一下', '闪一闪']) {
      const plan = buildPlan({ message: text, hasDiagnostics: false }) as ToolCallCardPlan;
      expect({ text, tool: toolOf(plan) }).toEqual({ text, tool: undefined });
      expect({ text, blink: (plan.beats || []).some((b) => !!b.blink) }).toEqual({ text, blink: true });
    }
  });

  it('闪烁 / 讲解节里指到的 id 都在图里存在（对得上）', () => {
    // 图不在这两个计划里（它们不重发 DSL），所以拿**内置案例**当参照物
    const known = new Set(WATER_PROCESS_DSL.units.map((u) => u.id));
    for (const text of ['让图元闪烁', '把工艺图放大', '看看污水处理工艺图', '故意画错工艺图']) {
      const plan = buildPlan({ message: text, hasDiagnostics: false }) as ToolCallCardPlan;
      for (const b of plan.beats || []) {
        if (b.pointAt === undefined) continue;
        expect({ text, at: String(b.pointAt), known: known.has(String(b.pointAt)) }).toEqual({
          text,
          at: String(b.pointAt),
          known: true,
        });
      }
    }
  });

  it('★ 第一个例子：每一拍都推镜头，且每一拍都指到位', () => {
    // 需求原话是"要随着讲解放大画布，并且把对应的元件高亮"。
    // 两条都按"每一拍"钉住：漏一拍就会出现"讲了半天画面没动"。
    const plan = buildPlan({ message: '看看污水处理工艺图', hasDiagnostics: false }) as ToolCallCardPlan;
    const beats = plan.beats || [];
    expect(beats.length).toBeGreaterThanOrEqual(8);
    for (const [i, b] of beats.entries()) {
      expect({ i, zoom: !!b.zoom }).toEqual({ i, zoom: true });
    }
    // 除了开场（先给全貌）与收尾，中间每一拍都要指着某个单元
    const pointed = beats.filter((b) => b.pointAt !== undefined);
    expect(pointed.length >= beats.length - 2).toBe(true);
  });

  it('★ 第一个例子的镜头是"远看 → 推近 → 回到全貌"', () => {
    const plan = buildPlan({ message: '看看污水处理工艺图', hasDiagnostics: false }) as ToolCallCardPlan;
    const beats = plan.beats || [];

    // "全貌"档是 `fit`（整图适配），不是某个手算的倍率 —— 所以它**没有** `scale`。
    // 理由见 scenarios.ts 的档位表：手写常数既算不准（跟窗口宽度、面板遮盖、图元尺寸有关），
    // 又会被 `to` 的平移语义带偏（保留上一个镜头的中心 → 一边被裁到画布外）。
    const isFit = (b: any) => b.zoom?.direction === 'fit';
    expect({ 开场: isFit(beats[0]) }).toEqual({ 开场: true });
    expect({ 收尾: isFit(beats[beats.length - 1]) }).toEqual({ 收尾: true });

    // 中间那些拍用绝对倍率，且**都比全貌近** —— 不然"随着讲解放大"就没有发生
    const scales = beats
      .map((b) => b.zoom?.scale)
      .filter((n): n is number => typeof n === 'number');
    expect(scales.length).toBeGreaterThan(0);
    const nearest = Math.max(...scales);
    expect(nearest).toBeGreaterThan(0.85 * 1.5);

    // 除了首尾那两个"全貌"，不该再有 `fit` —— 多出来的话"推近"就被打断了
    expect(beats.filter(isFit).length).toBeLessThanOrEqual(2);
    // 而且中间的拍必须是 `to`（相对倍率会累积，十几拍之后不可预期）
    for (const b of beats.filter((x) => x.zoom && !isFit(x))) {
      expect(b.zoom!.direction).toBe('to');
    }
  });

  it('★ 提标改造问法 → 走**改图**剧本，且带 STATE_DELTA 补丁', () => {
    for (const text of ['提标改造', '拆掉初沉池', '改图', '增删图元']) {
      const plan = buildPlan({ message: text, hasDiagnostics: false }) as ToolCallCardPlan;
      expect(toolOf(plan)).toBe(RENDER_DIAGRAM_TOOL);
      const patches = (plan.beats || []).filter((b) => b.patchState && b.patchState.length);
      expect(patches.length).toBeGreaterThan(0);
    }
  });

  it('★ 「提标改造」不能被"重画一张工艺图"抢走（它也含"工艺图"三个字）', () => {
    // 与缩放 / 闪烁同一条规矩：这条分支必须排在 `isWaterAsk` **之前**。
    // 排后面的话意图是"改图"的一句会被"再看看那张图"收走 —— 用户看不到任何改动。
    const plan = buildPlan({ message: '给这张工艺图做提标改造', hasDiagnostics: false }) as ToolCallCardPlan;
    expect(toolOf(plan)).toBe(RENDER_DIAGRAM_TOOL);
    expect((plan.beats || []).some((b) => !!b.patchState)).toBe(true);
  });

  it('★ 提标改造的补丁**删得掉、也加得上**，且顺序是"先删后加"', () => {
    const plan = buildPlan({ message: '提标改造', hasDiagnostics: false }) as ToolCallCardPlan;
    const ops = (plan.beats || []).flatMap((b) => b.patchState ?? []);
    expect(ops.length).toBeGreaterThan(0);
    // 两类操作都要有（只删不加 = 拆厂；只加不删 = 缺了"改接"那一半）
    expect(ops.some((o) => o.op === 'remove')).toBe(true);
    expect(ops.some((o) => o.op === 'add')).toBe(true);
    // 删的必须是管线 / 单元 / focus 这三类路径之一
    for (const op of ops.filter((o) => o.op === 'remove')) {
      expect(/^\/diagram\/(units|pipes|viewport\/focus)\/\d+$/.test(op.path)).toBe(true);
    }
    // 加的必须是"往末尾追加"（`/-`）—— 往中间插会让已有元素下标前移，
    // 而 `remove` 的下标是按**补丁前**算的（见 detectDiagramPatch）
    for (const op of ops.filter((o) => o.op === 'add')) {
      expect(/^\/diagram\/(units|pipes)\/-$/.test(op.path)).toBe(true);
    }
  });

  it('★ 提标改造的补丁能真的算出那张新图，且**新图也过校验**', () => {
    // 这条是"补丁要表达完整意图"的落地检查：删单元必须连带删它的管线、
    // 还要把 `viewport.focus` 里的它摘掉 —— 少任何一样，这份文档就不自洽。
    const plan = buildPlan({ message: '提标改造', hasDiagnostics: false }) as ToolCallCardPlan;
    const ops = (plan.beats || []).flatMap((b) => b.patchState ?? []);

    let doc: any = { diagram: structuredClone(WATER_PROCESS_DSL) };
    doc = applyJsonPatch(doc, ops);

    // 初沉池没了、提标段在
    const ids = doc.diagram.units.map((u: any) => u.id);
    expect(ids).not.toContain('primary');
    for (const id of ['ozone', 'carbon', 'membrane']) expect(ids).toContain(id);
    // 被取代的那根直连管线也没了
    expect(doc.diagram.pipes.map((p: any) => p.id)).not.toContain('pipe-filter-disinfect');
    // 没有悬空管线（两端都得在 units 里）
    const unitIds = new Set(ids);
    for (const pipe of doc.diagram.pipes) {
      expect({ pipe: pipe.id, ok: unitIds.has(pipe.sourceId) && unitIds.has(pipe.targetId) }).toEqual({
        pipe: pipe.id,
        ok: true,
      });
    }
    // `focus` 里不许再提被删的那个
    expect(doc.diagram.viewport.focus).not.toContain('primary');
    // 最终这张图本仓的守卫也要认（结构与取值都合法）
    expect(validateDiagramDsl(doc.diagram).valid).toBe(true);
  });

  it('readDiagnosticsTool 读出「哪个工具失败了」', () => {
    const withTool = input({
      context: [{ description: DSL_TOOL_CONTEXT_KEY, value: RENDER_DIAGRAM_TOOL }] as any,
    });
    expect(readDiagnosticsTool(withTool)).toBe(RENDER_DIAGRAM_TOOL);
    expect(readDiagnosticsTool(input())).toBeNull();
    // 只认自己的 key，别的 context 不会误判
    const other = input({
      context: [{ description: DSL_DIAGNOSTICS_CONTEXT_KEY, value: 'x' }] as any,
    });
    expect(readDiagnosticsTool(other)).toBeNull();
  });

  it('端到端：ScriptedAgent 拿到「图失败」的 context 时，产出的仍是图卡', async () => {
    const agent = new ScriptedAgent(NO_PACE);
    const events: any[] = [];
    for await (const event of agent.run(
      input({
        context: [
          { description: DSL_DIAGNOSTICS_CONTEXT_KEY, value: '[错误] units[34].kind：未知的符号种类' },
          { description: DSL_TOOL_CONTEXT_KEY, value: RENDER_DIAGRAM_TOOL },
        ] as any,
      })
    )) {
      events.push(event);
    }
    const start = events.find((e) => e.type === EventType.TOOL_CALL_START);
    expect(start?.toolCallName).toBe(RENDER_DIAGRAM_TOOL);
    const snapshot = events.find((e) => e.type === EventType.STATE_SNAPSHOT);
    expect(Object.keys(snapshot?.snapshot ?? {})).toEqual([STATE_DIAGRAM_KEY]);
  });
});

describe('人机回环：中断与 resume', () => {
  it('「下发指令」走中断剧本：吐表单 + RUN_FINISHED 带 outcome', () => {
    const plan = buildPlan({ message: '要下发指令', hasDiagnostics: false });

    expect(toolOf(plan)).toBe(COLLECT_INPUT_TOOL);
    expect(payloadOf(plan).kind).toBe('form');
    expect(payloadOf(plan).fields.length).toBeGreaterThan(0);
    expect(plan.interrupt).toBeTruthy();
    expect(plan.interrupt!.id).toBeTruthy();
    expect(plan.interrupt!.reason).toBeTruthy();

    // 事件序列的末尾确实带上了中断
    const events = planToEvents(plan, { threadId: 't1', runId: 'r1' });
    const finished = events[events.length - 1];
    expect(finished.type).toBe(EventType.RUN_FINISHED);
    expect(finished.outcome.type).toBe('interrupt');
    expect(finished.outcome.interrupts[0].id).toBe(plan.interrupt!.id);
  });

  it('resumeValues 从协议通道里取出用户填的值', () => {
    expect(resumeValues([{ interruptId: 'i1', status: 'resolved', payload: { a: 1 } }])).toEqual({ a: 1 });
  });

  it('status=cancelled 时视为"没有答复"', () => {
    expect(resumeValues([{ interruptId: 'i1', status: 'cancelled' }])).toBeNull();
  });

  it('没有 resume / 空数组时返回 null', () => {
    expect(resumeValues(null)).toBeNull();
    expect(resumeValues(undefined)).toBeNull();
    expect(resumeValues([])).toBeNull();
  });

  it('带 resume 进来 → 应答里带上了用户填的值', () => {
    const plan = buildPlan({
      message: '（已提交表单）',
      hasDiagnostics: false,
      resume: [{ interruptId: 'confirm-params', status: 'resolved', payload: { station: '一号泵站', flow: 1200 } }],
    });

    // 应答不产生新的工具卡（这一轮是"接着往下走"，不是"再问一次"）
    expect(plan.payload).toBeUndefined();
    expect(plan.interrupt).toBeUndefined();
    const text = plan.beats.map((b) => b.text).join('\n');
    expect(text).toContain('一号泵站');
    expect(text).toContain('1200');
    expect(text).toContain('resume');
  });

  it('resume 优先于关键词：带着答复来就不会又走一遍中断剧本', () => {
    const plan = buildPlan({
      message: '要下发指令', // 这个关键词平时会触发中断
      hasDiagnostics: false,
      resume: [{ interruptId: 'confirm-params', status: 'resolved', payload: { station: 'p2' } }],
    });
    expect(plan.interrupt).toBeUndefined();
    expect(toolOf(plan)).toBeUndefined();
  });
});

describe('ScriptedAgent', () => {
  it('NO_PACE 下产出的事件序列与 planToEvents 一致', async () => {
    // 播放节奏不属于事件序列——这条断言就是在钉这个分界
    const agent = new ScriptedAgent(NO_PACE);
    const collected: any[] = [];
    const req = input({ messages: [{ id: '1', role: 'user', content: '看看各渠道的月度销量' }] as any });
    for await (const event of agent.run(req)) collected.push(event);

    const expected = planToEvents(
      buildPlan({ message: '看看各渠道的月度销量', hasDiagnostics: false }),
      { threadId: 't1', runId: 'r1' }
    );
    expect(collected.map((e) => e.type)).toEqual(expected.map((e) => e.type));
  });

  it('带诊断的输入会得到修复版（列名对得上）', async () => {
    const agent = new ScriptedAgent(NO_PACE);
    const req = input({
      messages: [{ id: '1', role: 'user', content: '继续' }] as any,
      context: [{ description: DSL_DIAGNOSTICS_CONTEXT_KEY, value: '列「销售额」不存在' }] as any,
    });
    const collected: any[] = [];
    for await (const event of agent.run(req)) collected.push(event);

    const args = collected
      .filter((e) => e.type === EventType.TOOL_CALL_ARGS)
      .map((e) => e.delta)
      .join('');
    expect(JSON.parse(args).encoding.y).toBe('销量');
  });

  it('**带 resume 的输入**：agent 读得到用户填的值', async () => {
    const agent = new ScriptedAgent(NO_PACE);
    const req = input({
      messages: [{ id: '1', role: 'user', content: '（已提交表单）' }] as any,
      resume: [
        { interruptId: 'confirm-params', status: 'resolved', payload: { station: '一号泵站', flow: 1200 } },
      ] as any,
    });
    const collected: any[] = [];
    for await (const event of agent.run(req)) collected.push(event);

    const text = collected
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => e.delta)
      .join('');
    expect(text).toContain('一号泵站');
    expect(text).toContain('1200');
    // 这一轮不产生新的工具卡
    expect(collected.some((e) => e.type === EventType.TOOL_CALL_START)).toBe(false);
    // 也不带中断（这是一次普通结束）
    expect(collected[collected.length - 1].outcome).toBeUndefined();
  });

  it('中断剧本最后一条事件带 outcome', async () => {
    const agent = new ScriptedAgent(NO_PACE);
    const req = input({ messages: [{ id: '1', role: 'user', content: '要下发指令' }] as any });
    const collected: any[] = [];
    for await (const event of agent.run(req)) collected.push(event);

    const last = collected[collected.length - 1];
    expect(last.type).toBe(EventType.RUN_FINISHED);
    expect(last.outcome.type).toBe('interrupt');
  });

  it('abort 之后立刻停止产出', async () => {
    const agent = new ScriptedAgent(DEFAULT_PACE);
    const controller = new AbortController();
    const req = input({ messages: [{ id: '1', role: 'user', content: '看看销量' }] as any });

    const collected: any[] = [];
    for await (const event of agent.run(req, controller.signal)) {
      collected.push(event);
      if (collected.length === 2) controller.abort();
    }
    // 取消后不应该把整条 run 跑完
    expect(collected.length).toBeLessThan(39);
  });
});
