/**
 * app/ErrorBoundary.tsx —— 全局渲染错误边界
 *
 * 没有它，任何组件渲染异常 = 整树卸载 = 白屏，无从排查；
 * 有它，白屏变成可见的错误面板（信息+栈），这是可观测性的底线设施。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, overflow: 'auto', height: '100%' }}>
          <h2 style={{ color: '#dc2626', marginBottom: 8 }}>页面渲染出错</h2>
          <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
            请把下面的信息发给开发者（截图即可）。点击"重试"尝试恢复。
          </div>
          <div
            style={{
              background: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: 8,
              padding: 12,
              fontSize: 12.5,
              whiteSpace: 'pre-wrap',
              fontFamily: 'Consolas, monospace',
              color: '#991b1b',
              maxHeight: '60%',
              overflow: 'auto'
            }}
          >
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </div>
          <button
            className="primary"
            style={{ marginTop: 12 }}
            onClick={() => this.setState({ error: null })}
          >
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
