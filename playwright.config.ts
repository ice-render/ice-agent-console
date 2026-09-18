import { defineConfig } from '@playwright/test';

/**
 * ice-agent-console 端到端回归。
 *
 * 跟家族其它仓库不一样：这个工程**要起两个进程**——AG-UI 后端（8099）和静态页面（8100）。
 * 所以 webServer 从单个对象变成数组。Playwright 会等两个都就绪再开跑。
 *
 * 前置：`npm run build`（页面吃的是打包产物，不是 src）
 * 运行：`npm run test:e2e`
 *
 * 端口与家族其它仓库错开：引擎 8090 / 实体设计器 8091 / smart-water 8092 / game 8098。
 * `channel: 'chrome'`：用系统 Chrome，绕开 Playwright 自带无头壳与本地缓存版本对不上的坑。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  reporter: [['list']],
  webServer: [
    {
      command: 'npx tsx server/index.ts',
      port: 8099,
      reuseExistingServer: false,
      timeout: 30_000,
      /**
       * 强制剧本模式。
       *
       * e2e 断言的是**确定性的剧本产物**（某张卡片、某段文字、某个图元数），
       * 而开发机上很可能放着一份 `.env` 指着自己的模型（比如本机连 120 那台跑 qwopus）。
       * `loadConfig` 的优先级是「环境变量 > .env」，所以这里钉住模式，
       * 让"我这台机器上刚好配了模型"不会变成 e2e 的隐藏输入 —— 那种失败最难查：
       * 在 CI 上是绿的、在本机是红的，看起来像代码坏了。
       */
      env: { ICE_LLM_MODE: 'scripted' },
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
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    channel: 'chrome',
  },
});
