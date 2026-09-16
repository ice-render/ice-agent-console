/**
 * **开页自动开演**的开关判定。
 *
 * 纯函数，所以优先级能被穷举测掉 —— 这个仓的 `?demo=` / `?theme=` 都是同一口径：
 * **构建期定默认、运行期可覆盖、非法值落回默认**。
 * 三处口径必须一致，否则"分享链接里的参数"会有一套谁也说不清的行为。
 */
import { AUTOPLAY_OPENING, resolveAutoplay } from '../src/domain/agui/autoplay';

describe('autoplay 开关', () => {
  it('没给参数时用构建期默认', () => {
    expect(resolveAutoplay('', true)).toBe(true);
    expect(resolveAutoplay('', false)).toBe(false);
    // 无关参数不该影响它
    expect(resolveAutoplay('?theme=dark', true)).toBe(true);
    expect(resolveAutoplay('?demo=0', true)).toBe(true);
  });

  it('`?autoplay=1` / `=true` 打开，`=0` / `=false` 关掉', () => {
    expect(resolveAutoplay('?autoplay=1', false)).toBe(true);
    expect(resolveAutoplay('?autoplay=true', false)).toBe(true);
    expect(resolveAutoplay('?autoplay=0', true)).toBe(false);
    expect(resolveAutoplay('?autoplay=false', true)).toBe(false);
  });

  it('★ 显式参数**盖过**构建期默认（两个方向都能翻）', () => {
    // 演示站点上想安静地自己点：?autoplay=0
    expect(resolveAutoplay('?autoplay=0', true)).toBe(false);
    // 本地普通构建上想预览自动开演：?autoplay=1
    expect(resolveAutoplay('?autoplay=1', false)).toBe(true);
  });

  it('非法值落回构建期默认，不报错也不白屏', () => {
    for (const bad of ['whatever', '', 'yes', 'TRUE', '2', '-1']) {
      expect({ bad, on: resolveAutoplay(`?autoplay=${bad}`, true) }).toEqual({ bad, on: true });
      expect({ bad, off: resolveAutoplay(`?autoplay=${bad}`, false) }).toEqual({ bad, off: false });
    }
    // 参数在但没给值（`?autoplay`）也是非法 → 落回默认
    expect(resolveAutoplay('?autoplay', true)).toBe(true);
    expect(resolveAutoplay('?autoplay', false)).toBe(false);
  });

  it('与其它参数共存时互不干扰', () => {
    expect(resolveAutoplay('?theme=dark&autoplay=0&demo=1', true)).toBe(false);
    expect(resolveAutoplay('?demo=0&autoplay=1', false)).toBe(true);
  });

  it('开演用的那句话就是「工艺图」那组的第一个按钮', () => {
    // 这条钉的是"自动开演 = 替用户按下第一个快捷按钮"这件事。
    // 两边一旦分叉，演示站点上自动演出来的东西就与用户自己点的不一样了。
    expect(AUTOPLAY_OPENING).toBe('看看污水处理工艺图');
  });
});
