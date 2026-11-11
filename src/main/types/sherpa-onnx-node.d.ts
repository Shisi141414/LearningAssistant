/**
 * main/types/sherpa-onnx-node.d.ts —— sherpa-onnx-node 最小类型声明
 *
 * 该包是可选运行时依赖（npm install sherpa-onnx-node），VM 构建机不安装；
 * 代码用动态 import + 本声明做类型检查。
 * API 形状依据 k2-fsa/sherpa-onnx 官方 nodejs-addon-examples。
 */
declare module 'sherpa-onnx-node' {
  export interface OnlineStream {
    inputFinished(): void
    acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void
  }

  export interface OnlineRecognizerResult {
    text: string
    /** 命中热词的时间戳（可选特性） */
    tokens?: string[]
    timestamps?: number[]
  }

  export class OnlineRecognizer {
    constructor(config: unknown)
    createStream(): OnlineStream
    isReady(stream: OnlineStream): boolean
    decode(stream: OnlineStream): void
    isEndpoint(stream: OnlineStream): boolean
    reset(stream: OnlineStream): void
    getResult(stream: OnlineStream): OnlineRecognizerResult
  }
}
