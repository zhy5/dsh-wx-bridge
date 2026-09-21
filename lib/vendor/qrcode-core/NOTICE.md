# 来源与许可 / Provenance

本目录是 **`qrcode@1.5.4` 的编码核心**原样复制（未修改），来源包：

- npm：`qrcode@1.5.4`（MIT）
- 作者/版权：Copyright (c) 2012 Ryan Day（见同目录 `LICENSE`）
- 复制范围：该包的 `lib/core/*.js`（编码核心，**零外部依赖**，只互相 require）
- 未复制：`lib/renderer/*`、`bin/*`、`server.js` 等（依赖 `pngjs` / `yargs`，本插件不需要）

用途：插件自己的 `lib/vendor/qr-svg.cjs` 调用这里的 `qrcode.js` 得到模块矩阵，
再自行渲染成 SVG data URL，从而**不依赖用户环境里是否装有 `qrcode` 包**。

此外还复制了 **`dijkstrajs@1.0.3`（MIT）** 的 `dijkstra.js` → 本目录 `dijkstrajs.js`
（`segments.js` 用它做最优分段；许可见 `dijkstrajs.LICENSE`）。

**唯一一处对 vendored 代码的改动**：`segments.js` 里 `require('dijkstrajs')` → `require('./dijkstrajs')`。
原因：npm 打包默认忽略 `node_modules/`，把依赖放进 `lib/vendor/node_modules/` 会在发布包里丢掉
（等于重演"干净安装缺依赖"）。改相对路径后所有文件都在包内、零外部解析。

许可合规：MIT 允许复制与再分发，条件是保留版权与许可声明——`LICENSE`（qrcode）与
`dijkstrajs.LICENSE` 已随本目录一起分发；插件的 `README.md`「许可」一节也注明了这些第三方代码。
