const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

const WORKSPACE = path.resolve(__dirname, '..');

/**
 * ICE 家族在本地是**并列的仓库**，不是一个 monorepo。
 *
 * 每个包的 node_modules 里还各自躺着一份自己装的 ice-render，直接用 node 的解析规则
 * 打包会解析出**多份引擎实例**，引擎的类身份（typeId 注册表、instanceof、事件总线）
 * 就会错位——ice-chart 造出来的图元在引擎眼里不是"同一个 ICE 的组件"。
 *
 * 所以这里把用到的家族包**全部 alias 到同级仓库目录**，强制全工程只有一份 ice-render。
 * 副作用是好的：改完兄弟仓库的源码 npm run build 一下，本工程立刻吃到新版本。
 *
 * （M1 用引擎 + 图表 + DSL 三个包；控件层用 ice-web-components。）
 */
const family = {
  'ice-render': path.resolve(WORKSPACE, 'ice-render'),
  '@damoqiongqiu/ice-chart': path.resolve(WORKSPACE, 'ice-chart'),
  '@damoqiongqiu/ice-chart-dsl': path.resolve(WORKSPACE, 'ice-chart-dsl'),
  'ice-web-components': path.resolve(WORKSPACE, 'ice-web-components'),
  'ice-web-components-dsl': path.resolve(WORKSPACE, 'ice-web-components-dsl'),
  // 图卡片用：`ice-entity-designer` 把 `ice-render` 当 peer 依赖（它的 dist 里是
  // `require("ice-render")`），必须让它解析到**同一个**引擎目录，否则会出现第二份内核
  // —— 设计器建的图元在引擎眼里不是"同一个 ICE 的组件"。
  'ice-entity-designer': path.resolve(WORKSPACE, 'ice-entity-designer'),
};

module.exports = (env, argv) => {
  const isProd = argv.mode === 'production';

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
      alias: family,
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
