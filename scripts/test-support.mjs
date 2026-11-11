import { registerHooks } from 'node:module'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve as resolvePath, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

export const dataRoot = mkdtempSync(join(tmpdir(), 'learning-assistant-test-'))
export const handlers = new Map()
export const listeners = new Map()
export const events = []
export const electronMock = {
  app: { getPath: () => dataRoot },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from('encrypted:' + text),
    decryptString: (blob) => blob.toString().slice(10)
  },
  ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => listeners.set(name, handler) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
}
globalThis.__electronMock = electronMock
process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
const mainFrame = { url: process.env.ELECTRON_RENDERER_URL + '/' }
export const sender = Object.assign(new EventEmitter(), { mainFrame, isDestroyed: () => false, send: (channel, data) => events.push({ channel, data }) })
export const event = { sender, senderFrame: mainFrame }
export const invoke = (channel, ...args) => handlers.get(channel)(event, ...args)

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron') return { url: 'test:electron', shortCircuit: true }
    if (specifier.startsWith('@shared/')) return { url: pathToFileURL(resolvePath('shared', specifier.slice(8) + '.ts')).href, shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(specifier, context.parentURL)
      if (!existsSync(fileURLToPath(url)) && existsSync(fileURLToPath(url) + '.ts')) return { url: url.href + '.ts', shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'test:electron') return { format: 'module', source: 'export const {app,ipcMain,dialog,safeStorage}=globalThis.__electronMock;', shortCircuit: true }
    return next(url, context)
  }
})
