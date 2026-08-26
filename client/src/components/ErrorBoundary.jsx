import { Component } from 'react';
import styles from './ErrorBoundary.module.css';

/**
 * Catches render and lifecycle errors anywhere below it.
 *
 * Without this, a single thrown error unmounts the whole React tree and the
 * user is left on a blank white page — no message, no way back, and nothing
 * to report except "the app broke". That is the worst possible failure for a
 * tester, because it destroys the information we need to fix it.
 *
 * This has to be a class: there is no hook equivalent of componentDidCatch.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null, copied: false };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    // Keep it in the console for anyone with a debugger attached, and make a
    // best effort to tell the server. Never let the reporting itself throw —
    // an error handler that crashes is worse than no error handler.
     
    console.error('[RackTrack] render error:', error, info?.componentStack);
    try {
      const body = JSON.stringify({
        message: String(error?.message || error),
        stack: String(error?.stack || '').slice(0, 4000),
        componentStack: String(info?.componentStack || '').slice(0, 4000),
        path: window.location?.pathname,
        userAgent: navigator?.userAgent,
      });
      // sendBeacon survives the page being torn down and needs no auth header.
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/client-error', new Blob([body], { type: 'application/json' }));
      }
    } catch { /* reporting is best effort */ }
  }

  reset = () => this.setState({ error: null, info: null, copied: false });

  copy = () => {
    const { error, info } = this.state;
    const text = [
      `RackTrack error on ${window.location?.pathname}`,
      String(error?.message || error),
      String(error?.stack || '').split('\n').slice(0, 8).join('\n'),
      String(info?.componentStack || '').split('\n').slice(0, 8).join('\n'),
    ].join('\n\n');
    navigator.clipboard?.writeText(text).then(
      () => this.setState({ copied: true }),
      () => { /* clipboard blocked — the details are on screen anyway */ },
    );
  };

  render() {
    const { error, info, copied } = this.state;
    if (!error) return this.props.children;

    return (
      <div className={styles.wrap} role="alert">
        <div className={styles.card}>
          <div className={styles.icon} aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>

          <h1 className={styles.title}>This screen stopped working</h1>
          <p className={styles.body}>
            Something went wrong drawing this page. Your scans and data are safe -
            this is a display problem, not a lost-work problem.
          </p>

          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={this.reset}>
              Try again
            </button>
            <button
              type="button"
              className={styles.ghost}
              onClick={() => { window.location.href = '/'; }}
            >
              Go to Home
            </button>
          </div>

          <details className={styles.details}>
            <summary>Details for support</summary>
            <pre className={styles.pre}>{String(error?.message || error)}
{String(info?.componentStack || '').split('\n').slice(0, 6).join('\n')}</pre>
            <button type="button" className={styles.copy} onClick={this.copy}>
              {copied ? 'Copied' : 'Copy details'}
            </button>
          </details>
        </div>
      </div>
    );
  }
}
