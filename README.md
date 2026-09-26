演示站点 —— 由 `npm run deploy:pages`（= `npm run build:demo` + 推送）生成。

**不要手工改这个分支**：每次部署都会用 `--force` 覆盖成一整份新产物。
源码与文档在 `main`。

产物是纯前端：不连任何后端，直接双击 `index.html`（`file://`）也能跑。
