import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

/** Converts any render-time throw from a blank white screen into a recoverable
 *  message. The dashboard is also the onboarding surface and is watched over an SSH
 *  tunnel, so a silent unmount would strand an operator with no signal. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surfaced in the browser console for operators who open devtools / check logs.
    console.error('orquestra dashboard: render error', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ maxWidth: 560, margin: '15vh auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
        <h2 style={{ marginTop: 0 }}>The dashboard hit an error</h2>
        <p>Something failed while rendering. Your node keeps running — this only affects the dashboard view.</p>
        <p style={{ color: '#a00', fontFamily: 'monospace', fontSize: 13, wordBreak: 'break-word' }}>
          {this.state.error.message}
        </p>
        <p>Reload to retry, or check the node logs (<code>docker compose logs -f</code>).</p>
        <button onClick={() => { this.setState({ error: null }); location.reload() }}>Reload</button>
      </div>
    )
  }
}
