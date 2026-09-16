/**
 * 事件归约器：把一串 AG-UI 事件折叠成一个 thread 状态。
 *
 * 三条设计约束，都是前面讨论定下来的：
 *
 * 1. **事件是"已发生的事实"，不是"服务端下发的命令"。**
 *    所以这里是"把事实折叠成状态"，不是"执行命令"。白拿两样东西：
 *    事件日志本身可以当回放素材（配合 ICETracePlayerModel），
 *    以及遇到不认识的事件可以直接丢——不会崩，也不会污染状态。
 *
 * 2. **messages 是主结构，state 是卡片的局部状态。**
 *    Thread 式对话里，时间线才是骨架；画布状态是挂在某张卡片上的。
 *    这也决定了 `STATE_DELTA` 的作用对象是"最后一张图表卡片"，而不是某个全局画布。
 *
 * 3. **纯函数 + effects。**
 *    reducer 不碰 DOM、不碰 canvas，需要命令式动作时吐一条 effect 描述出来，
 *    由视图层执行。好处是归约器可以被穷举测试（连"边画边指"的顺序都能断言），
 *    而 canvas 相关的脏活留在真正需要它的地方。
 */
import { EventType } from '@ag-ui/core';
import {
  EVT_POINT_AT,
  EVT_POINT_CLEAR,
  EVT_ZOOM,
  RENDER_DIAGRAM_TOOL,
  STATE_CHART_KEY,
  STATE_DIAGRAM_KEY,
  type ZoomDirection,
} from '../../../shared/contract';
import {
  CHART_ROWS_PATH,
  applyJsonPatch,
  detectDiagramPatch,
  detectRowAppend,
  type JsonPatchOp,
} from './state-patch';

// ---------------------------------------------------------------------------
// 状态形状
// ---------------------------------------------------------------------------

export interface TextItem {
  kind: 'text';
  id: string;
  role: string;
  text: string;
  done: boolean;
}

export interface ToolItem {
  kind: 'tool';
  id: string;
  name: string;
  /** 流式拼装中的参数原文。前端就是靠它显示"DSL 正在拼"。 */
  argsRaw: string;
  status: 'streaming' | 'args-done' | 'result';
  /** 参数拼完并解析成功后的 DSL。解析失败则留在 argsRaw 里给用户看。 */
  dsl?: any;
  parseError?: string;
  result?: string;
  /** 表单卡：用户已经提交过（避免重复提交，也让卡片能显示终态）。 */
  submitted?: boolean;
}

export type ThreadItem = TextItem | ToolItem;

export interface ThreadState {
  threadId: string;
  runId: string | null;
  /**
   * `waiting` = run 正常结束了，但**留了一个待答复的中断**。
   *
   * 协议里中断也是 `RUN_FINISHED`（带 `outcome.type === 'interrupt'`），
   * 如果一律记成 idle，后续逻辑就会以为一切正常 —— 用户还没填表呢。
   */
  status: 'idle' | 'running' | 'waiting' | 'error';
  items: ThreadItem[];
  /**
   * AG-UI 的共享状态文档。`STATE_SNAPSHOT` 整体写它，`STATE_DELTA` 打补丁。
   *
   * **存的是完整文档，不是拆出来的 chart。** 因为 JSON Patch 的 path 是相对根的
   * （我们的约定是 `/chart/...`），把 `snapshot.chart` 单独拆出来存，
   * 补丁路径就对不上了。协议里的 state 本来就是"一份两边都看得见的文档"，
   * 我们只是往里放了一个 chart 字段而已。
   */
  sharedState: any | null;
  /**
   * 最近一次「指着讲」的目标。
   * `seq` 递增是为了让视图能区分"同一个值再指一次"——高亮动画需要重新触发。
   */
  pointAt: { value: any; seq: number } | null;
  /**
   * 最近一次缩放视图的指令。
   *
   * 同样带 `seq`：连发两条 `in` 必须真的放大两次。没有 seq 的话视图侧只能看到
   * "值没变"而忽略第二次（`pointAt` 那一处踩过同样的坑）。
   *
   * `'to'` 是**绝对**倍率（给 `scale`），讲解脚本用它 —— 相对倍率在一段十几拍的
   * 解说里会累积，而绝对倍率是幂等的。见 `shared/contract.ts` 的 `EVT_ZOOM`。
   */
  zoom: {
    direction: ZoomDirection;
    factor?: number;
    steps?: number;
    scale?: number;
    seq: number;
  } | null;
  /**
   * 渲染端诊断。由视图层校验 DSL 后回写，下一次 run 会带上它去触发自修复。
   * 这就是 AG-UI 双向语义的落点：协议的 `context` 字段。
   */
  diagnostics: string | null;
  error: string | null;
  /**
   * 待答复的中断。协议规定恢复方式是**开一个新 run** 并在 `resume` 里逐条应答。
   * M1 一次只处理一个（多中断时取第一个，其余的记在 items 里由卡片各自呈现）。
   */
  interrupt: { id: string; reason: string; message?: string; toolCallId?: string } | null;
  /** 已折叠的事件数。标题栏显示，顺带给 e2e 一个稳定的锚点。 */
  eventCount: number;
}

/** 视图层希望 reducer 帮忙做的事。reducer 只描述，不执行。 */
export type Effect =
  | { type: 'mount-chart'; toolCallId: string; dsl: any }
  | { type: 'append-rows'; toolCallId: string; rows: any[][] }
  /** `blink` 是"高亮之后再闪一下"，与 `value` 同属一次定位动作（见 shared/contract.ts）。 */
  | { type: 'point-at'; value: any; blink?: boolean }
  | { type: 'clear-point' }
  | { type: 'zoom'; direction: ZoomDirection; factor?: number; steps?: number; scale?: number }
  /**
   * **增量增删图元**（`STATE_DELTA` 里那批增删补丁的落点）。
   *
   * 不带 dsl —— 它要的就是"别重建"。新增的 `units` / `pipes` 直接
   * `createSymbol` / `createPipe`，`removed*Ids` 交给 `designer.remove()`。
   */
  | {
      type: 'patch-diagram';
      units: any[];
      pipes: any[];
      removedUnitIds: string[];
      removedPipeIds: string[];
    };

export interface Reduction {
  state: ThreadState;
  effects: Effect[];
}

// ---------------------------------------------------------------------------
// 本地动作
// ---------------------------------------------------------------------------

/**
 * 不是来自协议的动作。前缀 `@local/` 保证不会跟 `EventType` 的字面量撞名
 * （`EventType` 全是 UPPER_SNAKE）。
 */
export type LocalAction =
  | { type: '@local/user-message'; text: string }
  | { type: '@local/form-submitted'; toolCallId: string }
  | { type: '@local/diagnostics'; text: string | null }
  | { type: '@local/reset' };

export type Action = { type: string } & Record<string, any>;

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

export function initialState(threadId: string): ThreadState {
  return {
    threadId,
    runId: null,
    status: 'idle',
    items: [],
    sharedState: null,
    pointAt: null,
    zoom: null,
    diagnostics: null,
    interrupt: null,
    error: null,
    eventCount: 0,
  };
}

// ---------------------------------------------------------------------------
// 归约
// ---------------------------------------------------------------------------

/**
 * 某个工具产出的 DSL 在 state 里挂哪个键。
 *
 * 全量回退时要用它：`state` 是**一份文档**（`{chart: …}` / `{diagram: …}`），
 * 直接把整份文档当 DSL 传给视图层是错的 —— 视图层的校验器会拦下来，
 * 症状是"补丁一来图就变成一张报错的空卡"（这条路径以前没有用例走过，是加图元增删时发现的）。
 */
function stateKeyFor(tool: string): string {
  return tool === RENDER_DIAGRAM_TOOL ? STATE_DIAGRAM_KEY : STATE_CHART_KEY;
}

/** 找到最后一次产出 DSL 的工具项——`STATE_DELTA` 的作用对象。 */
function lastChartItem(items: ThreadItem[]): ToolItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === 'tool' && item.dsl !== undefined) return item;
  }
  return undefined;
}

function indexOfItem(items: ThreadItem[], id: string): number {
  return items.findIndex((item) => item.id === id);
}

/**
 * 把一个动作折叠进状态。
 *
 * 注意 `default` 分支：**不认识的事件直接丢弃**。
 * 这不是偷懒，是协议要求的容错口径（业界共识的护栏是 `default: drop(ev)`）——
 * 未来的协议版本会加新事件类型，客户端不能因为不认识就崩。
 * 但丢弃只发生在"事件"上；`STATE_DELTA` 里不认识的 **patch 操作** 会抛异常，
 * 因为那是"我认识这个事件、但内容超出我的实现"，静默忽略会让状态悄悄分叉。
 */
export function reduce(state: ThreadState, action: Action): Reduction {
  const effects: Effect[] = [];
  const next: ThreadState = { ...state, items: state.items.slice() };
  const bump = () => {
    next.eventCount = state.eventCount + 1;
  };

  switch (action.type) {
    // ---------------------------------------------------------------- 本地
    case '@local/user-message': {
      next.items.push({
        kind: 'text',
        id: `local_user_${state.items.length}_${state.eventCount}`,
        role: 'user',
        text: action.text,
        done: true,
      });
      return { state: next, effects };
    }

    case '@local/form-submitted': {
      const index = indexOfItem(next.items, action.toolCallId);
      if (index !== -1) {
        const item = next.items[index] as ToolItem;
        if (item.kind === 'tool') next.items[index] = { ...item, submitted: true };
      }
      // 提交即意味着这次中断被答复了；`RUN_STARTED` 还会再清一次，两处都留着更稳
      next.interrupt = null;
      return { state: next, effects };
    }

    case '@local/diagnostics': {
      next.diagnostics = action.text ?? null;
      // 诊断是某一轮渲染的结果。宣告新一轮开始时它就该清掉，
      // 否则会一直挂在 context 上，让 agent 以为每轮都有错。
      return { state: next, effects };
    }

    case '@local/reset': {
      return { state: initialState(state.threadId), effects };
    }

    // ------------------------------------------------------------ 生命周期
    case EventType.RUN_STARTED: {
      bump();
      next.runId = action.runId ?? null;
      next.status = 'running';
      next.error = null;
      // 新一轮开始 = 上一轮的诊断已经用掉了。清掉，免得反复回灌同一份。
      next.diagnostics = null;
      // 中断同理：开新 run 就是"这件事翻篇了"（协议规定恢复中断的方式正是开新 run）。
      next.interrupt = null;
      return { state: next, effects };
    }

    case EventType.RUN_FINISHED: {
      bump();
      const interrupts = action.outcome?.type === 'interrupt' ? action.outcome.interrupts : null;
      if (Array.isArray(interrupts) && interrupts.length > 0) {
        // 注意：中断**也是** RUN_FINISHED（协议如此），所以这里不改 RunFinished 的语义，
        // 只是把状态推进到 waiting —— 用户还没答复，界面不该显示"空闲"。
        next.interrupt = interrupts[0];
        next.status = 'waiting';
      } else {
        next.status = 'idle';
      }
      return { state: next, effects };
    }

    case EventType.RUN_ERROR: {
      bump();
      next.status = 'error';
      next.error = action.message || 'run 失败';
      return { state: next, effects };
    }

    // ---------------------------------------------------------------- 文本
    case EventType.TEXT_MESSAGE_START: {
      bump();
      next.items.push({
        kind: 'text',
        id: action.messageId,
        role: action.role || 'assistant',
        text: '',
        done: false,
      });
      return { state: next, effects };
    }

    case EventType.TEXT_MESSAGE_CONTENT: {
      bump();
      const index = indexOfItem(next.items, action.messageId);
      if (index === -1) {
        // 没收到 START 就来 CONTENT（中途接入、或服务端不守规矩）。
        // 不丢——补一条出来，比让用户看不到内容强。
        next.items.push({
          kind: 'text',
          id: action.messageId,
          role: 'assistant',
          text: '',
          done: false,
        });
      }
      const at = index === -1 ? next.items.length - 1 : index;
      const item = next.items[at] as TextItem;
      next.items[at] = { ...item, text: item.text + (action.delta ?? '') };
      return { state: next, effects };
    }

    case EventType.TEXT_MESSAGE_END: {
      bump();
      const index = indexOfItem(next.items, action.messageId);
      if (index !== -1) {
        const item = next.items[index] as TextItem;
        next.items[index] = { ...item, done: true };
      }
      return { state: next, effects };
    }

    // ------------------------------------------------------------ 工具调用
    case EventType.TOOL_CALL_START: {
      bump();
      next.items.push({
        kind: 'tool',
        id: action.toolCallId,
        name: action.toolCallName,
        argsRaw: '',
        status: 'streaming',
      });
      return { state: next, effects };
    }

    case EventType.TOOL_CALL_ARGS: {
      bump();
      const index = indexOfItem(next.items, action.toolCallId);
      if (index === -1) return { state: next, effects };
      const item = next.items[index] as ToolItem;
      const argsRaw = item.argsRaw + (action.delta ?? '');
      next.items[index] = { ...item, argsRaw };
      return { state: next, effects };
    }

    case EventType.TOOL_CALL_END: {
      bump();
      const index = indexOfItem(next.items, action.toolCallId);
      if (index === -1) return { state: next, effects };
      const item = next.items[index] as ToolItem;
      // 参数拼完了：这时才尝试解析。解析失败不抛——把原文留在卡片上给用户看，
      // 比让整条流挂掉有用得多（模型吐半截 JSON 是很常见的情况）。
      let dsl: any;
      let parseError: string | undefined;
      try {
        dsl = JSON.parse(item.argsRaw);
      } catch (err) {
        parseError = (err as Error).message;
      }
      next.items[index] = { ...item, status: 'args-done', dsl, parseError };
      if (dsl !== undefined) {
        effects.push({ type: 'mount-chart', toolCallId: item.id, dsl });
      }
      return { state: next, effects };
    }

    case EventType.TOOL_CALL_RESULT: {
      bump();
      const index = indexOfItem(next.items, action.toolCallId);
      if (index !== -1) {
        const item = next.items[index] as ToolItem;
        next.items[index] = { ...item, status: 'result', result: action.content };
      }
      return { state: next, effects };
    }

    // ------------------------------------------------------------ 状态同步
    case EventType.STATE_SNAPSHOT: {
      bump();
      // 快照语义是**替换**而不是合并（协议明确规定），所以直接赋值。
      next.sharedState = action.snapshot ?? null;
      return { state: next, effects };
    }

    case EventType.STATE_DELTA: {
      bump();
      const ops = (action.delta ?? []) as JsonPatchOp[];
      let patched: any;
      try {
        patched = applyJsonPatch(next.sharedState, ops);
      } catch (err) {
        // patch 应用不了 = 状态分叉，必须让用户看见，不能装作没事
        next.status = 'error';
        next.error = `STATE_DELTA 应用失败：${(err as Error).message}`;
        return { state: next, effects };
      }
      next.sharedState = patched;

      // 三条路径由两个纯函数决定（见 state-patch.ts 的注释）：
      //  1. 只往 rows 末尾追加 → `appendData` 快路径；
      //  2. 只增删图元          → 增量 `createSymbol` / `remove`，**不重建**；
      //  3. 其它                → 全量重建（贵一点，但一定对）。
      const target = lastChartItem(next.items);
      const append = detectRowAppend(ops, CHART_ROWS_PATH);
      // ⚠️ 传的是**补丁前**的文档（`state.sharedState`）：补丁里给的是下标，
      //    要把它翻译成"删哪个 id"只能看旧文档。
      const diagramPatch = target?.name === RENDER_DIAGRAM_TOOL
        ? detectDiagramPatch(ops, state.sharedState)
        : { isElementPatch: false as const };

      if (append.isPlainAppend && target) {
        effects.push({ type: 'append-rows', toolCallId: target.id, rows: append.rows });
      } else if (diagramPatch.isElementPatch && target) {
        effects.push({
          type: 'patch-diagram',
          units: (diagramPatch as any).units,
          pipes: (diagramPatch as any).pipes,
          removedUnitIds: (diagramPatch as any).removedUnitIds,
          removedPipeIds: (diagramPatch as any).removedPipeIds,
        });
      } else if (target) {
        // 全量：按目标那一层的 stateKey 取出**它自己那份 DSL**，不是整份 state
        effects.push({ type: 'mount-chart', toolCallId: target.id, dsl: patched?.[stateKeyFor(target.name)] });
      }
      return { state: next, effects };
    }

    // ---------------------------------------------------------- 自定义 / 叙事
    case EventType.CUSTOM: {
      bump();
      if (action.name === EVT_POINT_AT) {
        // seq 递增：同一个值连指两次也要重新触发高亮
        next.pointAt = { value: action.value?.value, seq: (state.pointAt?.seq ?? 0) + 1 };
        effects.push({
          type: 'point-at',
          value: next.pointAt.value,
          // blink 原样透传（只在 `true` 时带上，保持 effect 形状最小）
          ...(action.value?.blink === true ? { blink: true } : {}),
        });
      } else if (action.name === EVT_POINT_CLEAR) {
        next.pointAt = null;
        effects.push({ type: 'clear-point' });
      } else if (action.name === EVT_ZOOM) {
        const direction = action.value?.direction;
        // `'to'` 还要求一个有限正数 `scale` —— 少了它这条命令没有意义，
        // 而"补一个默认值"会让视图侧跳到某个谁也想不到的倍率上，所以宁可整条丢掉。
        const toScale = Number(action.value?.scale);
        const toValid = direction === 'to' && Number.isFinite(toScale) && toScale > 0;
        if (
          direction === 'in' ||
          direction === 'out' ||
          direction === 'reset' ||
          // `'fit'` 不带参数（整图适配的倍率由视图层从内容包围盒算出来），所以要**单独**列出来。
          // ⚠️ 漏掉它的症状很隐蔽：命令在协议里合法、到了视图层也能执行，
          //    却在这里被当"非法方向"静默丢掉 —— 画面停在上一档，不报错。
          direction === 'fit' ||
          toValid
        ) {
          next.zoom = {
            direction,
            ...(action.value?.factor !== undefined ? { factor: action.value.factor } : {}),
            ...(action.value?.steps !== undefined ? { steps: action.value.steps } : {}),
            ...(toValid ? { scale: toScale } : {}),
            seq: (state.zoom?.seq ?? 0) + 1,
          };
          effects.push({
            type: 'zoom',
            direction,
            ...(next.zoom.factor !== undefined ? { factor: next.zoom.factor } : {}),
            ...(next.zoom.steps !== undefined ? { steps: next.zoom.steps } : {}),
            ...(next.zoom.scale !== undefined ? { scale: next.zoom.scale } : {}),
          });
        }
        // 方向/参数非法就当这条命令没来过：不破坏已有视口，也不报错
      }
      // 其它 CUSTOM 事件（别的应用、别的扩展）保持沉默地路过
      return { state: next, effects };
    }

    default:
      // 协议词表之外的事件——直接丢。这是规范要求的容错口径，
      // 也是"事件是事实、不是命令"的直接好处：不认识的事实不影响已知状态。
      return { state, effects };
  }
}

/** 把一串动作折叠到底，返回最终状态（不含 effects）。测试和回放都用它。 */
export function reduceAll(state: ThreadState, actions: Action[]): ThreadState {
  return actions.reduce((acc, action) => reduce(acc, action).state, state);
}
