/**
 * **管线不许穿越图元** —— 真实案例上的落墨判据。
 *
 * 与 `tests/diagram-layout.test.ts` 是一对：
 * 那条管"图元之间别压住"（纯坐标，纯逻辑），这条管"**线别横穿图元**"。
 * 两者的共同点是：改完靠人眼扫一遍是抓不住回归的 —— 图上多一条穿线，看起来只是"有点乱"，
 * 而它会随着每次调布局、每次换端口悄悄出现又消失。
 *
 * ## 为什么要借用引擎来判
 *
 * 折线是**引擎算的**（`ICEVisioLink.interpolate()`：候选路径 → 正交/不倒走/不相交过滤 → 打分）。
 * 在测试里复刻一份路由算法等于把判据建在"我以为引擎会怎么画"上 —— 那种测试永远绿，
 * 而且引擎一改就假绿。所以这里**真的建一颗 ICE 实例、真的建图**，再读引擎算完的
 * `state.points`（世界坐标）。
 *
 * ## 判据
 *
 * 逐条管线、逐段折线，与**非端点图元**的形状盒做相交判定；穿过盒子的内部才算违规
 * （贴边、擦过不算）。端点本身不参与 —— 线本来就要从它身上接出来。
 */
import { EventBus, ICE } from 'ice-render';
import { WaterProcessDesigner } from 'ice-entity-designer';
import { compileDiagramDsl } from '../src/domain/diagram/compile';
import { WATER_PROCESS_DSL } from '../shared/water-process-case';

/** 与 `diagram-layer.ts` 相同的建图路径：先全部单元，再全部管线。 */
function buildDesigner() {
  const ice: any = new ICE();
  ice.evtBus = new EventBus();
  ice.childNodes = [];
  ice.toolNodes = [];
  const designer: any = new WaterProcessDesigner(ice);
  for (const op of compileDiagramDsl(WATER_PROCESS_DSL)) {
    if (op.op === 'symbol') {
      designer.createSymbol((op as any).kind, {
        id: op.id,
        name: (op as any).name,
        tag: (op as any).tag,
        left: (op as any).left,
        top: (op as any).top,
      });
    } else {
      designer.createPipe({
        id: op.id,
        sourceId: (op as any).sourceId,
        targetId: (op as any).targetId,
        medium: (op as any).medium,
        dn: (op as any).dn,
        sourcePort: (op as any).sourcePort,
        targetPort: (op as any).targetPort,
      });
    }
  }
  return designer;
}

/** 形状盒（不含位号/名称文字盒）—— 用户说"线穿过了图元"，说的就是这个盒子。 */
function shapeBox(node: any) {
  const s = node.state;
  return { minX: s.left, minY: s.top, maxX: s.left + s.width, maxY: s.top + s.height };
}

/** 线段是否穿进矩形内部（留 0.5px 内缩：贴边、擦过不算）。 */
function segmentEntersBox(a: number[], b: number[], box: any, inset = 0.5): boolean {
  const minX = box.minX + inset;
  const maxX = box.maxX - inset;
  const minY = box.minY + inset;
  const maxY = box.maxY - inset;
  if (minX >= maxX || minY >= maxY) return false;

  // 两个端点都在盒内 → 直接算穿（不含端点在盒外但整段擦过的情形）
  const inside = (p: number[]) => p[0] > minX && p[0] < maxX && p[1] > minY && p[1] < maxY;
  if (inside(a) || inside(b)) return true;

  // 否则看是否与四条边相交（Liang-Barsky 裁剪）
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return (
    clip(-dx, a[0] - minX) &&
    clip(dx, maxX - a[0]) &&
    clip(-dy, a[1] - minY) &&
    clip(dy, maxY - a[1]) &&
    t1 - t0 > 1e-9
  );
}

/** 跑一遍路由（引擎渲染时走的就是这条），返回 `{pipeId: 世界坐标折线}`。 */
function routedPolylines(designer: any): Map<string, number[][]> {
  const out = new Map<string, number[][]>();
  for (const pipe of designer.edges) {
    // `__calcDots()` 是渲染路径的入口；它内部会调 `interpolate()` 并把结果写回 `state.points`
    pipe.recalculateRoute();
    pipe.__calcDots();
    out.set(String(pipe.state.id), (pipe.state.points || []).map((p: number[]) => [p[0], p[1]]));
  }
  return out;
}

function crossingsOf(designer: any) {
  const polylines = routedPolylines(designer);
  const crossings: Array<{ pipe: string; symbol: string }> = [];
  for (const pipe of designer.edges) {
    const id = String(pipe.state.id);
    const points = polylines.get(id) || [];
    const from = String(pipe.state.links?.start?.id ?? '');
    const to = String(pipe.state.links?.end?.id ?? '');
    for (const node of designer.nodes) {
      const symbolId = String(node.state.id);
      if (symbolId === from || symbolId === to) continue;
      const box = shapeBox(node);
      const hit = points.some((p, i) => i > 0 && segmentEntersBox(points[i - 1], p, box));
      if (hit) crossings.push({ pipe: id, symbol: symbolId });
    }
  }
  return { crossings, polylines };
}

describe('工艺图：管线不许穿越图元', () => {
  it('★ 真实案例（37 条管线 / 78 个图元）：零穿越', () => {
    const designer = buildDesigner();
    const { crossings, polylines } = crossingsOf(designer);

    // 自检：别让"没建出来"伪装成"没穿越"
    expect(polylines.size).toBeGreaterThan(30);
    expect(designer.nodes.length).toBeGreaterThan(60);
    // ⚠️ jest 的 `expect` 只吃一个参数（别写 `expect(x, '消息')`）—— 失败信息交给下面那条数组断言。
    const tooShort = [...polylines.entries()].filter(([, points]) => points.length < 2).map(([id]) => id);
    expect(tooShort).toEqual([]);

    const readable = crossings.map((c) => `${c.pipe} ✕ ${c.symbol}`);
    expect(readable).toEqual([]);
  });
});
