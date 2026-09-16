import { expect, test } from '@playwright/test';
import {
  FORM_CANVAS,
  chipLocator,
  collectErrors,
  countInk,
  readStage,
  settleAfter,
} from './helpers';

/**
 * **第二批控件的原型页。**
 *
 * 这条用例的价值不在"没报错"，而在它守住了两个**只有真去看画出来什么**才会发现的 bug
 * （都是做这一版原型时才暴露的）：
 *
 * 1. **色板全白**：`ICEColorPicker` 要的是 `colors: string[]`（一串颜色值），
 *    而我把选项归一化成了 `{value,label}` 对象传进去 —— 组件不报错，色块画成空白。
 * 2. **占位文案全丢**：`createControl` 有 6 个老分支 + 9 个新分支漏了展开 `base`
 *    （它装着 `placeholder`），于是下拉框 / 日期框 / 级联 / 树选择 / 自动完成的
 *    占位文案从来没画出来过。TypeScript 抓不到 —— `placeholder` 都是**可选**参数。
 *
 * 所以判据不是"卡片出来了"，而是"色板真的有色"、"占位文案真的画了字"、
 * "值真的进得了取值回路"。
 */

const CHIP = '看看新控件都能用吗';

async function openShowcase(page: import('@playwright/test').Page) {
  await page.goto('/');
  return settleAfter(page, async () => {
    await chipLocator(page, CHIP).click();
  });
}

test('10 个字段全部上画布，色板有色、占位文案有字', async ({ page }) => {
  const errors = collectErrors(page);
  const after = await openShowcase(page);

  // ---- 真的切到了表单图层，且 10 个字段都在 ----
  const tool = (after.items.filter((i) => i.kind === 'tool') as any[])[0];
  expect(tool.name).toBe('collect_input');
  expect(tool.dsl.kind).toBe('form');
  expect(tool.dsl.fields.map((f: any) => f.name)).toEqual([
    'themeColor',
    'priority',
    'triggerAt',
    'window',
    'region',
    'station',
    'tags',
    'risk',
    'keyword',
    'devices',
  ]);

  await expect(page.locator(FORM_CANVAS)).toBeVisible();
  expect((await readStage(page)).active, '绘图区应当切到表单层').toBe('form');
  expect(await countInk(page, FORM_CANVAS)).toBeGreaterThan(10000);

  // ---- ① 色板真的有色 ----
  //
  // 那个 bug 的回归：传 `{value,label}` 对象时色块**全是白的**，这里会数到 0~1 种色相。
  // 合法值有 8 个颜色，所以要求至少 5 种不同的饱和色。
  const hues = await page.evaluate(() => {
    const canvas = document.querySelector('.stage-layer[data-kind=\"form\"] canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const scale = canvas.width / canvas.getBoundingClientRect().width;
    // 色板是第一个字段，色块在 y ≈ 60~200（CSS 像素）那一条
    const { data } = ctx.getImageData(0, Math.round(60 * scale), canvas.width, Math.round(140 * scale));
    const buckets = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (data[i + 3] === 0) continue;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max - min < 60) continue; // 灰白背景与描边不算
      let hue = 0;
      if (max === r) hue = ((g - b) / (max - min)) * 60;
      else if (max === g) hue = (2 + (b - r) / (max - min)) * 60;
      else hue = (4 + (r - g) / (max - min)) * 60;
      buckets.add(Math.floor((((hue % 360) + 360) % 360) / 12)); // 每 12° 一档，抗抖动
    }
    return buckets.size;
  });
  expect(hues, '色板上一个饱和的颜色都没有 —— 选项形状传错了（传了对象而不是色值）').toBeGreaterThanOrEqual(5);

  // ---- ② 占位文案真的画了字 ----
  //
  // 组件画字段用的就是这两个取值器之一（库里两个名字都有，见 `fieldTexts()` 的注释），
  // 所以问它们最直接。**下面这几条正是那个 bug 的回归**：
  // 修之前 `region` / `station` / `keyword` 全是空 —— 占位文案根本没传进控件。
  const texts = await page.evaluate(() => (window as any).__iceAgentConsole.formFieldTexts());
  const byName: Record<string, string | null> = Object.fromEntries(
    texts.map((t: any) => [t.name, t.text])
  );
  expect(byName.region, '级联的占位文案应当画出来').toBe('选省 / 市');
  expect(byName.station, '树选择的占位文案应当画出来').toBe('按分组选');
  expect(byName.keyword, '自动完成的占位文案应当画出来').toBe('输入以筛选');
  expect(byName.triggerAt, '时间框的初值应当画出来').toBe('08:30');
  // 不是每个类型都有文字取值器：`segmented` / `rate` / `transfer` 两个都没有
  // （它们的取值由子节点自己画），所以这里不断言 —— 但**值**由下一个用例守着。
  expect(String(byName.window), '区间日期应当画出两头').toContain('2026-09-01');
  expect(String(byName.window)).toContain('2026-09-07');

  // ---- 内容宽度仍然停在 640 上限，没溢出画布 ----
  const bounds = await page.evaluate(() => {
    const canvas = document.querySelector('.stage-layer[data-kind=\"form\"] canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let maxX = -1;
    for (let y = 0; y < canvas.height; y++) {
      const row = y * canvas.width * 4;
      for (let x = 0; x < canvas.width; x++) if (data[row + x * 4 + 3] !== 0) maxX = Math.max(maxX, x);
    }
    return {
      right: maxX / (canvas.width / canvas.getBoundingClientRect().width),
      css: canvas.getBoundingClientRect().width,
    };
  });
  expect(bounds.right).toBeLessThanOrEqual(bounds.css + 1);
  expect(bounds.right).toBeGreaterThan(500);

  expect(errors, errors.join('\n')).toEqual([]);
});

/**
 * 新类型真的进了**取值回路** —— 这才叫"能当字段"。
 *
 * 外壳画出来是一回事，值能不能被表单读出来是另一回事，而那正是当初判定
 * "`upload` / `radio-button` 不能当字段"的判据。所以这里往 7 个新控件里写值，
 * 再问表单模型拿到了什么。
 */
test('往新控件里写值，表单模型读得到（值真的进了回路）', async ({ page }) => {
  const after = await openShowcase(page);
  expect(after.status).toBe('idle');

  const ok = await page.evaluate(() =>
    (window as any).__iceAgentConsole.fillForm({
      themeColor: '#F59E0B',
      priority: 'high',
      triggerAt: '09:15',
      window: ['2026-10-01', '2026-10-15'],
      region: 'hz',
      station: 'pump-2',
      tags: ['例检', '抢修'],
      risk: 5,
      keyword: '阀门',
      devices: ['V-101', 'P-201'],
    })
  );
  expect(ok).toBe(true);

  const values = await page.evaluate(() => (window as any).__iceAgentConsole.formValues());

  // 标量：直接回读
  expect(values.triggerAt).toBe('09:15');
  expect(values.priority).toBe('high');
  expect(values.risk).toBe(5);
  expect(values.keyword).toBe('阀门');
  // `color` 会**强制转成字符串**（组件自己的行为，运行时探测过）
  expect(values.themeColor).toBe('#F59E0B');
  // 级联 / 树选择：值是最深一层 / 节点的 key
  expect(values.region).toBe('hz');
  expect(values.station).toBe('pump-2');
  // 元组：两头都在
  expect(values.window).toEqual(['2026-10-01', '2026-10-15']);
  // 数组：穿梭框会按数据源过滤，多选 select 保持数组
  expect(values.tags).toEqual(['例检', '抢修']);
  expect(values.devices).toEqual(['V-101', 'P-201']);
});
