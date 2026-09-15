/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  // 家族包指向同级仓库的构建产物。工程里没有 node_modules 软链（那是 `file:` 依赖的路子，
  // 有记录在案的坑），webpack 靠 resolve.alias、tsc 靠 paths，jest 就靠这个映射。
  // 前置：兄弟仓库各自 `npm run build` 过。
  moduleNameMapper: {
    '^@damoqiongqiu/ice-chart-dsl$': '<rootDir>/../ice-chart-dsl/dist/index.cjs',
    '^@damoqiongqiu/ice-chart$': '<rootDir>/../ice-chart/dist/index.cjs',
    '^ice-web-components$': '<rootDir>/../ice-web-components/dist/index.cjs',
    '^ice-render$': '<rootDir>/../ice-render/dist/index.cjs',
    // 图 DSL 的校验器要从这个包取符号/介质的白名单（单一事实来源，不复制一张会漂移的表）。
    // 它的 dist 只 `require("ice-render")`，上面那条映射已经覆盖。
    '^ice-entity-designer$': '<rootDir>/../ice-entity-designer/dist/index.cjs',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        // 单测覆盖 src/domain（纯逻辑）与 server（协议层 + 事件序列编译器），
        // 两边都不碰 DOM，也不需要工程那份 dom/esnext 的 tsconfig。
        tsconfig: {
          module: 'commonjs',
          target: 'es2020',
          lib: ['es2020'],
          types: ['jest', 'node'],
          esModuleInterop: true,
          strict: false,
          skipLibCheck: true,
        },
      },
    ],
  },
  collectCoverageFrom: ['src/domain/**/*.ts', 'server/**/*.ts'],
};
