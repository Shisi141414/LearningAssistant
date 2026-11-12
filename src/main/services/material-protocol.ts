import { net, protocol } from 'electron'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { materialPath } from './materials'
import { learningAssetResponse } from './learning-assets'

// 必须在 app.ready 前声明；只用于托管原件、校验后的图片附件及已安装 PDF.js 的静态资源。
export function declareMaterialProtocol(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'study-material', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])
}
export function registerMaterialProtocol(): void {
  protocol.handle('study-material', async request => {
    try {
      if (request.method !== 'GET') return new Response(null, { status: 405 })
      const origin = request.headers.get('Origin')
      // 使用浏览器生成的发起源而非可由页面控制的 referrer。
      const initiator = (request as Request & { initiatorOrigin?: string | null }).initiatorOrigin
      const allowedOrigins = process.env.ELECTRON_RENDERER_URL ? [new URL(process.env.ELECTRON_RENDERER_URL).origin] : ['null', 'file://']
      if ((initiator && !allowedOrigins.includes(initiator)) || (origin && !allowedOrigins.includes(origin))) return new Response(null, { status: 403 })
      const url = new URL(request.url)
      if (url.hostname === 'learning-assets' && /^\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname) && !url.search) {
        const response = await learningAssetResponse(url.pathname.slice(1))
        response.headers.set('Access-Control-Allow-Origin', origin || 'null')
        return response
      }
      let file: string
      if (url.hostname === 'file' && /^\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname)) {
        file = materialPath(url.pathname.slice(1))
        if (!file.toLowerCase().endsWith('.pdf')) return new Response(null, { status: 415 })
      } else if (url.hostname === 'assets' && /^\/(cmaps|standard_fonts|wasm)\/[A-Za-z0-9_-]+\.(bcmap|pfb|ttf|woff2?|wasm)$/.test(url.pathname)) {
        const root = dirname(createRequire(__filename).resolve('pdfjs-dist/package.json'))
        file = join(root, ...url.pathname.slice(1).split('/'))
      } else return new Response(null, { status: 404 })
      const headers: Record<string, string> = {}
      const range = request.headers.get('Range')
      if (range) headers.Range = range
      const response = await net.fetch(pathToFileURL(file).href, { headers })
      const resultHeaders = new Headers(response.headers)
      resultHeaders.set('Access-Control-Allow-Origin', origin || 'null')
      resultHeaders.set('Cache-Control', 'no-store')
      if (file.endsWith('.pdf')) resultHeaders.set('Content-Type', 'application/pdf')
      if (file.endsWith('.wasm')) resultHeaders.set('Content-Type', 'application/wasm')
      return new Response(response.body, { status: response.status, headers: resultHeaders })
    } catch { return new Response(null, { status: 404 }) }
  })
}
