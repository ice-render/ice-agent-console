/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  // 家族包不需要映射：它们是 package.json 里的普通 npm 依赖，jest 自己就能从
  // node_modules 解析到（口径与理由见 README §8.1）。
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
