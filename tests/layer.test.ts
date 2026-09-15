/**
 * 层：一块 canvas + 一个 ICE 实例。
 *
 * 这一层故意很薄——引擎在 2.12.0 补齐 `fitCanvasToDisplaySize()` 之后，
 * 应用侧关于"尺寸"的部分就只剩一次转交。所以这里测的就是两件事：
 * **尺寸有没有转交**，以及**销毁有没有漏**（漏一个就是一张画布 + 一个 rAF 留着）。
 */
import { Layer, LayerSet } from '../src/domain/ice/layer';

function fakeIce() {
  const fitCalls: Array<[number, number]> = [];
  let destroyCount = 0;
  return {
    fitCalls,
    get destroyCount() {
      return destroyCount;
    },
    fitCanvasToDisplaySize(width: number, height: number): boolean {
      fitCalls.push([width, height]);
      return true;
    },
    destroy(): void {
      destroyCount++;
    },
  } as any;
}

function fakeCanvas(width = 300, height = 150): HTMLCanvasElement {
  return { width, height } as HTMLCanvasElement;
}

describe('Layer', () => {
  it('fit 把尺寸转交给引擎（应用不自己写 canvas 尺寸）', () => {
    const ice = fakeIce();
    const canvas = fakeCanvas();
    const layer = new Layer('chart', canvas, ice);

    expect(layer.fit(800, 300)).toBe(true);
    expect(ice.fitCalls).toEqual([[800, 300]]);
    // 画布自身没有被这一层改过
    expect(canvas.width).toBe(300);
  });

  it('backingSize 读的是画布的设备像素尺寸', () => {
    const layer = new Layer('chart', fakeCanvas(1600, 600), fakeIce());
    expect(layer.backingSize).toEqual({ width: 1600, height: 600 });
  });

  it('destroy 收到引擎上，且幂等', () => {
    const ice = fakeIce();
    const layer = new Layer('chart', fakeCanvas(), ice);

    layer.destroy();
    layer.destroy();

    expect(ice.destroyCount).toBe(1);
  });
});

describe('LayerSet', () => {
  it('重复 id 直接抛（静默覆盖会让"少收一个层"变得查不出来）', () => {
    const set = new LayerSet();
    set.add(new Layer('a', fakeCanvas(), fakeIce()));

    expect(() => set.add(new Layer('a', fakeCanvas(), fakeIce()))).toThrow(/已存在/);
  });

  it('destroyAll 把所有层都收掉', () => {
    const first = fakeIce();
    const second = fakeIce();
    const set = new LayerSet();
    set.add(new Layer('chart', fakeCanvas(), first));
    set.add(new Layer('widgets', fakeCanvas(), second));

    set.destroyAll();

    expect(first.destroyCount).toBe(1);
    expect(second.destroyCount).toBe(1);
    expect(set.ids()).toEqual([]);
  });

  it('get / ids 能取到已注册的层', () => {
    const set = new LayerSet();
    const layer = set.add(new Layer('chart', fakeCanvas(), fakeIce()));

    expect(set.get('chart')).toBe(layer);
    expect(set.get('nope')).toBeUndefined();
    expect(set.ids()).toEqual(['chart']);
  });
});
