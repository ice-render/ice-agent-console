/**
 * 协议侧的数据 → ICE 能吃的形状。**纯翻译函数，不碰 DOM、不碰 canvas。**
 *
 * 这些函数原本住在 `src/view/chart-adapter.ts` 里，但那个模块为了 `createChart`
 * 要在顶层 import ICE——于是纯逻辑跟着一起变成了"必须起一个画布才能测"。
 * 挪到 domain 层之后它们可以在 node 环境里被穷举测试，而 adapter 只留命令式的那部分。
 *
 * 这个拆分本身就是"纯核心 + 命令式外壳"的落点：**判断**在这里，**动手**在 adapter。
 */

export interface AppendPlan {
  seriesId: string;
  /** `appendData` 要的 `[x, y]` 点。 */
  points: any[][];
}

/**
 * 判断这批行能不能安全地走 `appendData`。返回 null = 判不了，调用方应退回全量重绘。
 *
 * **这是整个工程里最像"适配层"的一个函数**，值得解释它在解决什么：
 *
 * 协议层面，agent 说的是"state 变了，这是 JSON Patch"。渲染层面，ICE 收到全量
 * `setOption` 也能画对，但那意味着每个数据点都要重新编译一遍 DSL、重建坐标系。
 * 而 `appendData` 是专为"只加几个点"准备的快路径。
 *
 * 但它有硬约束：**只往 `series.data` 末尾 concat，不碰 `xAxis.data`**。
 * 类目轴（bar / 类目折线）编译出来的 `series.data` 是纯数值数组、类目名单独存在
 * `xAxis.data` 里，所以往类目轴追加一个新类目用 `appendData` 会错位。
 * 数值轴 / 时间轴编译出来是 `[[x, y], ...]`，那才是它被设计出来服务的场景。
 *
 * 所以这里认出类目轴就返回 null——宁可慢一点走全量，也不能"看着对但内部错"。
 * 判错的后果不会当场报错，只会在某个时刻以"图怎么不对"的形式浮现，那种 bug 最难查。
 */
export function planAppend(option: any, rows: any[][]): AppendPlan[] | null {
  const series = option?.series;
  if (!Array.isArray(series) || series.length === 0) return null;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const axes = Array.isArray(option.xAxis) ? option.xAxis : [option.xAxis];
  if (axes.some((axis: any) => axis?.type === 'category')) return null;

  const grouped = new Map<string, any[][]>();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) return null;
    // DSL 约定：三列以上时第三列是分组列（对应 encoding.series）
    const key = row.length >= 3 ? String(row[2]) : null;
    const target =
      key === null ? series[0] : series.find((s: any) => s?.name === key || s?.id === key);
    if (!target?.id) return null;
    const bucket = grouped.get(target.id);
    if (bucket) bucket.push([row[0], row[1]]);
    else grouped.set(target.id, [[row[0], row[1]]]);
  }

  return Array.from(grouped, ([seriesId, points]) => ({ seriesId, points }));
}

/**
 * 注入"往返"所需的交互开关。
 *
 * 这些不是图表外观，而是**上行通道**：没有它们，用户在图上点击/框选不会产生任何事件，
 * "用户指着图问"这条回路就是断的——画布变成了只能看不能碰的图片。
 *
 * 放在这一层而不是 DSL 里，是因为它是**这个应用的需要**，不是图表定义的一部分：
 * 同一份 DSL 换个宿主（比如只做导出的批处理场景）就不需要这些开关。
 * DSL 自己指定的 interaction 优先级更高（后展开）。
 */
export function withRoundTripInteractions(option: any): any {
  return {
    ...option,
    interaction: {
      hover: { enabled: true },
      select: { enabled: true, mode: 'single' },
      brush: { enabled: true, axes: 'x', mode: 'select' },
      ...(option?.interaction || {}),
    },
  };
}
