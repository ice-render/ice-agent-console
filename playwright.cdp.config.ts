import { defineConfig } from '@playwright/test';

/**
 * **CDP 模式**：跑在"已经开着的那只 Chrome"里，人能当场看见。
 *
 * ```
 * # ① 先开一只带调试端口的 Chrome（端口/profile 与别的工具错开）
 * "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *   --remote-debugging-port=9223 --user-data-dir=/tmp/codex-chrome-cdp \
 *   --no-first-run --no-default-browser-check --window-size=1440,900
 *
 * # ② 再跑（两种 transport 各一条命令）
 * ICE_CDP_ENDPOINT=http://127.0.0.1:9223 npm run test:cdp -- e2e/demo-mode.spec.ts
 * ICE_CDP_ENDPOINT=http://127.0.0.1:9223 ICE_CONSOLE_API_MODE=llm npm run test:cdp -- e2e/live.spec.ts
 * ```
 *
 * ## 与 `playwright.config.ts` 的分工
 *
 * | | `playwright.config.ts` | 这个文件 |
 * |---|---|---|
 * | 浏览器 | Playwright 自己拉起（无头） | 连你开着的 Chrome（CDP） |
 * | 用途 | 门禁 / CI | 人看着跑、当场复盘 |
 * | 并行 | 5 workers | **1 worker**（一条条来，看得清） |
 * | 超时 | 60s | 默认 240s（真模型一轮可能要一两分钟） |
 *
 * ### 为什么 worker 只有 1 个
 *
 * 不是性能考虑，是**可看性**：5 个 worker 会在同一只窗口里抢标签页，
 * 屏幕上画面乱跳，等于什么都没看见。要看就得一条一条来。
 *
 * ### 超时为什么单独放宽
 *
 * 真模型（`ICE_LLM_MODE=llm`）走的是 `server/agents/llm.ts`，
 * 一轮"想 → 调工具 → 再想"在本地推理模型上要几十秒，60s 会把它误判成超时。
 * 确定性剧本（scripted / demo）用不着这么长，`ICE_E2E_TIMEOUT` 可以调回来。
 *
 * ⚠️ `AGENTS.md` 的端口约定不变：8099 后端 + 8100 页面，`reuseExistingServer: false`
 * 照旧 —— 端口被别的仓占着时要响亮失败，不要静默复用别人的服务目录。
 */
const CDP_ENDPOINT = process.env.ICE_CDP_ENDPOINT ?? 'http://127.0.0.1:9223';

/**
 * 8099 那只后端跑哪种 agent。
 *
 * `playwright.config.ts` 把 `ICE_LLM_MODE` **钉死**成 `scripted`，是为了让 e2e
 * 断言的是确定性剧本产物、"本机刚好配了模型"不成为隐藏输入。CDP 模式要能
 * 故意跑真模型，所以这里把它变成显式入参，默认仍是 `scripted`（与门禁同一口径）。
 */
const API_MODE = process.env.ICE_CONSOLE_API_MODE ?? 'scripted';
const TIMEOUT = Number(process.env.ICE_E2E_TIMEOUT ?? 240_000);

export default defineConfig({
  testDir: './e2e',
  timeout: TIMEOUT,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  workers: 1,
  fullyParallel: false,
  retries: 0,
  webServer: [
    {
      command: 'npx tsx server/index.ts',
      port: 8099,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { ICE_LLM_MODE: API_MODE },
    },
    {
      command: 'npx http-server dist -p 8100 -c-1 --silent',
      port: 8100,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
  use: {
    baseURL: 'http://localhost:8100',
    /**
     * **故意不写 `viewport`**：CDP 模式下页面尺寸就是那扇窗的真实内容区
     * （1440×900 的窗口扣掉标题栏/书签栏）。钉一个 viewport 会造成
     * "断言按 1440×900 算、人看到的却不是那个尺寸"的错位。
     */
  },
  metadata: { cdpEndpoint: CDP_ENDPOINT, apiMode: API_MODE },
});
