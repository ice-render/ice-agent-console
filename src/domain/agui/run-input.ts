/**
 * 一次 run 的**输入形状**，以及它到协议原生 `RunAgentInput` 的映射。
 *
 * ## 为什么单独一个文件（原来是内联在 `client.ts` 的 fetch 里）
 *
 * 那个映射本来长在远端 transport 的 `fetch` 调用里，和网络缠在一起。加了
 * 浏览器内的 transport（`local-agent.ts`）之后，它有**两个**消费者了 ——
 * 两份各拼一份 `RunAgentInput` 迟早会漂，而其中有个很容易写错的条件：
 * **`resume` 是空数组时不能带上**。
 *
 * 提出来之后它成了纯函数，可以被穷举断言（`tests/transport.test.ts`）——
 * 这是它从"网络代码的一块"变成"可测的协议边界"的那一步。
 *
 * ## 与 `@ag-ui/core` 的关系
 *
 * 这里定义的是**本工程的用法**（哪些字段必填、默认值是什么），不是协议本身。
 * 真正的类型由 `@ag-ui/core` 的 schema 定义，构建时按官方 schema 校验
 * （`tests/dsl-to-events.test.ts` 就是这么干的）。
 */
import type { RunAgentInput } from '@ag-ui/core';

export interface RunMessage {
  id: string;
  role: string;
  content: string;
}

/** 对应协议里的 `RunAgentInput`。 */
export interface RunRequest {
  threadId: string;
  runId: string;
  messages: RunMessage[];
  state?: any;
  /** 应用扩展通道。自修复回路就是靠它把渲染端诊断带回去的。 */
  context?: Array<{ description: string; value: string }>;
  /**
   * 对上一轮中断的答复。
   *
   * 协议规定：恢复一个被中断的 run 的方式是**开一个新的 run**，并在 `resume` 里
   * 逐条应答所有仍然打开的中断（`interruptId` + `status` + `payload`）。
   * `status` 只有 `'resolved'` / `'cancelled'` 两个取值（这是 schema 里的枚举，不是自定的）。
   */
  resume?: ResumeEntry[];
}

/** 对应协议里的 `ResumeEntry`。 */
export interface ResumeEntry {
  interruptId: string;
  status: 'resolved' | 'cancelled';
  /** 用户的答复。表单场景就是 `getValues()` 的产物。 */
  payload?: any;
}

export interface RunHandlers {
  onEvent: (event: any) => void;
  onError?: (error: Error) => void;
  onDone?: () => void;
}

/**
 * **跑一次 run** —— 这是全部 transport 的统一签名。
 *
 * 它是一个函数类型，所以"换掉后端"这件事的粒度就是**换一个函数**：
 * - `client.ts` 的 `runAgent` —— POST + SSE，连真后端；
 * - `local-agent.ts` 的 `runAgentLocally` —— 在浏览器里跑 `ScriptedAgent`。
 *
 * 两者的行为约定必须一致（尤其是**取消语义**：`signal` abort 掉之后静默返回，
 * 不当成错误上报），否则换 transport 会让上层的错误处理看到不一样的世界。
 */
export type RunTransport = (
  request: RunRequest,
  handlers: RunHandlers,
  signal?: AbortSignal
) => Promise<void>;

/**
 * `RunRequest` → 协议原生的 `RunAgentInput`。
 *
 * 两个**刻意的默认值**：
 * - `state` 缺省补 `{}` —— 协议要求这个字段存在（客户端回传"画面上现在是什么"）；
 * - `context` 缺省补 `[]`；
 * - `tools` / `forwardedProps` 恒为 `[]` / `{}`：这个工程的工具是**服务端定死**的
 *   （`buildPlan` 里那几个），不走协议的客户端工具声明通道。
 *
 * 一个**刻意的省略**：`resume` 为空数组时**不带这个字段**。
 * 空数组在协议里是合法的，但语义上多余 —— "没有任何中断要回复"和"回复了 0 条"
 * 不该长得一样。带上它还会让服务端多做一次"这条 resume 对应哪个中断"的查找。
 */
export function toRunAgentInput(request: RunRequest): RunAgentInput {
  return {
    threadId: request.threadId,
    runId: request.runId,
    state: request.state ?? {},
    messages: request.messages,
    context: request.context ?? [],
    tools: [],
    forwardedProps: {},
    ...(request.resume && request.resume.length > 0 ? { resume: request.resume } : {}),
  } as RunAgentInput;
}
