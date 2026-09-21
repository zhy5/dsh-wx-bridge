/**
 * 自带二维码渲染（零外部依赖）—— 给「微信连接」面板出配对二维码。
 *
 * 为什么自带：插件此前靠 `require.resolve('qrcode')` 在用户 profile 里找那个包，
 * 而插件本身 `dependencies` 为空 —— 干净安装的机器根本没有它，面板就只剩"备用链接"
 * （2026-09-21 其他用户实测反馈）。
 *
 * 组成：
 *   - `qrcode-core/`：从 `qrcode@1.5.4`（MIT，Copyright (c) 2012 Ryan Day）原样复制的**编码核心**，
 *     零外部依赖（只互相 require）；见同目录 LICENSE 与 NOTICE.md。
 *   - 本文件：只用核心产出模块矩阵，然后自己画 **SVG**（省掉 pngjs/yargs 等依赖与 PNG 编码）。
 *
 * 输出是 `data:image/svg+xml;base64,…`，可直接喂给 `<img src>`（Chromium 正常渲染）。
 */
const QRCode = require('./qrcode-core/qrcode')

/** 取模块矩阵：{size, get(r,c)}。 */
function modules(text, ecLevel) {
  const qr = QRCode.create(String(text), { errorCorrectionLevel: ecLevel || 'M' })
  const size = qr.modules.size
  const data = qr.modules.data
  return {
    size,
    get: (r, c) => !!data[r * size + c],
    version: qr.version,
    ecLevel: qr.errorCorrectionLevel && qr.errorCorrectionLevel.bit !== undefined ? qr.errorCorrectionLevel.bit : null,
    maskPattern: qr.maskPattern,
  }
}

/**
 * 渲染成 SVG data URL。
 * @param {string} text 要编码的内容（配对时是微信返回的二维码内容）
 * @param {{size?:number, margin?:number, ecLevel?:string}} [opts] size=目标边长(px)，margin=静默区格数
 */
function toSvgDataUrl(text, opts) {
  const o = opts || {}
  const m = modules(text, o.ecLevel)
  const margin = o.margin === undefined ? 2 : o.margin
  const target = o.size || 320
  const scale = Math.max(1, Math.floor(target / (m.size + margin * 2)))
  const px = (m.size + margin * 2) * scale
  const rects = []
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      if (m.get(r, c)) {
        rects.push('<rect x="' + ((c + margin) * scale) + '" y="' + ((r + margin) * scale) + '" width="' + scale + '" height="' + scale + '"/>')
      }
    }
  }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px + '" ' +
    'shape-rendering="crispEdges" viewBox="0 0 ' + px + ' ' + px + '">' +
    '<rect width="' + px + '" height="' + px + '" fill="#ffffff"/>' +
    '<g fill="#000000">' + rects.join('') + '</g></svg>'
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64')
}

module.exports = { toSvgDataUrl, modules }
