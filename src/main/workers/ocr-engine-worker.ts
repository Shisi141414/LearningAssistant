import { createRequire } from 'node:module'

// OCR 引擎只读已校验的本地语言包。缺包时失败，不回退到联网下载。
globalThis.fetch = async () => { throw new Error('OCR 识别线程不允许联网，请先准备本地语言包') }
createRequire(__filename)('tesseract.js/src/worker-script/node/index.js')
