const path = require('path');
const fs = require('fs');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');

const PUBLIC_DIR = path.resolve(__dirname, 'public');

/**
 * 把 `public/` 里**除 index.html 之外**的文件原样搬进 `dist/`。
 *
 * ## 为什么必须有这一步
 *
 * `HtmlWebpackPlugin` 只吐 index.html，而 `output.clean` 每次又会清空 dist/。
 * 但 TDK/SEO 那几件东西里的 robots.txt 与 sitemap.xml **必须是站点根目录下的真实文件**：
 * 爬虫请求的是 `https://<站>/robots.txt`、`/sitemap.xml`，不是某个前端路由
 * —— 它们只存在于 public/ 里的话，构建一跑就没了（本地因为 dev-server 直接拿
 * public/ 当静态目录，还**看不出来**，只有对着 dist/ 或者线上站点才发现）。
 * og-cover.jpg 同理：社交卡片抓的是那个 URL，404 的话卡片就是空白。
 *
 * 规则只有一条：**public/ 下的非入口文件，原样进 dist/**。加了新的静态文件不用改这里。
 *
 * ## 为什么不装 copy-webpack-plugin
 *
 * 三个小文件（两个文本 + 一张图）而已。装一个插件要跟着一条依赖树走，
 * 而这里 20 行就干完了 —— 见 AGENTS 第 1 条那句"不要顺手改上游"的同一个意思：
 * 能自己收口的，别引依赖。
 */
class CopyPublicFiles {
  /** @param {{ from: string, ignore?: string[] }} options */
  constructor({ from, ignore = [] }) {
    this.from = from;
    this.ignore = new Set(ignore);
  }

  apply(compiler) {
    compiler.hooks.thisCompilation.tap('CopyPublicFiles', (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: 'CopyPublicFiles',
          // ADDITIONAL：在压缩类插件之前挂上，且与其它产物的生成顺序无关
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
        },
        () => {
          for (const name of fs.readdirSync(this.from)) {
            if (this.ignore.has(name)) continue;
            const abs = path.join(this.from, name);
            if (!fs.statSync(abs).isFile()) continue;
            compilation.emitAsset(name, new compiler.webpack.sources.RawSource(fs.readFileSync(abs)));
          }
        }
      );
    });
  }
}

/**
 * 家族包（引擎 / 图表 / chart-dsl / 控件库 / 表单 DSL / 实体设计器）走
 * **`package.json` 的 `dependencies`**，由 webpack 正常从 `node_modules` 解析 ——
 * 这里**没有 alias**。
 *
 * 2026-09-26 之前有：把六个包 alias 到同级的兄弟仓库目录，好让"改完兄弟仓的源码
 * 立刻生效"。撤掉的理由是"工程要能跑起来、结构要清楚"（见 README §8.1）——
 * 只 clone 了本仓的机器上没有那些同级目录，而 webpack 的 alias **不回落**
 * （tsc 的 `paths` 会、jest 的 `moduleNameMapper` 不会），构建直接 `Module not found`。
 * 现在上游迭代的口径是**改上游 → 发版 → 本仓跟进 pin**，不再指着同级目录。
 *
 * ⚠️ 别顺手加回来。哪怕只是"加一条 alias 省得装包"，也得连带处理
 * "目录不存在时不要写这条 alias"，否则等于把修好的洞重新挖开。
 * 单实例（引擎全工程只能有一份，否则 typeId 注册表错位）现在靠 npm 的 dedupe：
 * 六个包共用顶层那一份 `ice-render`，`npm ls ice-render` 里全是 `deduped`。
 */
module.exports = (env, argv) => {
  const isProd = argv.mode === 'production';

  /**
   * **演示模式**：`npm run build:demo`（= `webpack --mode production --env demo`）。
   *
   * 这时的产物**不连后端** —— 前端在浏览器里直接跑 `server/agents/scripted.ts`
   * 那份剧本 agent（见 `src/domain/agui/local-agent.ts`），所以 `dist/` 可以扔到
   * GitHub Pages 之类的纯静态托管上做演示站点，甚至 `file://` 双击打开。
   * 运行期还能用 `?demo=0` 切回连后端（优先级见 `src/domain/agui/transport.ts`）。
   *
   * ## 为什么这里要引入 DefinePlugin（本仓此前没有任何构建期常量先例）
   *
   * 既有的"切行为"手段有三类：`argv.mode`（构建期，但只有 prod/dev 两档）、
   * URL 查询参数（`?theme=`）、`globalThis` 覆盖（`ICE_AGENT_API`）。
   * **"是不是演示产物"与"prod/dev"是正交的两维** —— 演示站点要用 production 构建，
   * 所以 `argv.mode` 表达不了这件事。而另外两类都是**运行期**的，
   * 定不了默认值（演示站点裸链不能要求用户先加个 `?demo=1`）。
   *
   * 只剩构建期常量这一条路，DefinePlugin 就是它。**别因为"以前没有"就绕开** ——
   * 绕开的代价是要么多一份 entry、要么在产物里塞个假 URL。
   */
  const demo = Boolean(env && env.demo);

  return {
    entry: {
      boot: path.resolve(__dirname, 'src/entries/boot.ts'),
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: isProd ? '[name].[contenthash:8].js' : '[name].js',
      clean: true,
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: [
            {
              // 只转译不做类型检查（类型门禁交给 `npm run types:check`），构建快得多
              loader: 'ts-loader',
              options: { transpileOnly: true },
            },
          ],
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: path.resolve(__dirname, 'public/index.html'),
        filename: 'index.html',
        chunks: ['boot'],
      }),
      // public/ 下的静态文件（robots.txt / sitemap.xml / og-cover.jpg）原样进 dist/。
      // 见这个类上面的长注释：它们是"站点根目录的文件"，不是前端路由。
      new CopyPublicFiles({ from: PUBLIC_DIR, ignore: ['index.html'] }),
      // 注入构建期常量（读取处与说明见 `src/domain/agui/transport.ts`）。
      // `JSON.stringify` 是必须的：DefinePlugin 做的是**源码文本替换**，
      // 直接给 `false` 会替换成字面量 `false`（碰巧对），但给字符串就会漏掉引号。
      new webpack.DefinePlugin({ __ICE_DEMO__: JSON.stringify(demo) }),
    ],
    // 打进来的是引擎 + 图表 + DSL 三个库，体积天然大，别刷警告
    performance: { hints: false },
    devServer: {
      static: { directory: path.resolve(__dirname, 'public') },
      port: 8100,
      open: false,
      hot: true,
      // 这里**故意不配 proxy**：SSE 走 dev-server 的反向代理容易被中间层缓冲，
      // 出问题时很难判断是协议问题还是代理问题。改为 server 直接开 CORS，
      // 前端直连 http://localhost:8099/agui（见 server/index.ts 的允许来源）。
    },
    devtool: isProd ? false : 'eval-source-map',
  };
};
