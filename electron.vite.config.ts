import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts'), 'calendar-worker': resolve(__dirname, 'src/main/workers/calendar-worker.ts'), 'material-worker': resolve(__dirname, 'src/main/workers/material-worker.ts'), 'ocr-engine-worker': resolve(__dirname, 'src/main/workers/ocr-engine-worker.ts'), 'learning-asset-worker': resolve(__dirname, 'src/main/workers/learning-asset-worker.ts'), 'learning-package-worker': resolve(__dirname, 'src/main/workers/learning-package-worker.ts') },
        // 可选原生依赖（VM 构建机不安装，运行时动态加载；不声明则 rolldown 试图打包而失败）
        external: ['sherpa-onnx-node']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared'),
        '@': resolve(__dirname, 'src/renderer/src')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html'), print: resolve(__dirname, 'src/renderer/print.html') }
      }
    }
  }
})
