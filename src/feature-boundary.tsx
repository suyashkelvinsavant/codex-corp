import { Component, Suspense, type ErrorInfo, type ReactNode } from "react";

type FeatureBoundaryProps = {
  name: string;
  children: ReactNode;
};

type FeatureBoundaryState = {
  error: Error | null;
};

/**
 * Keeps a failed lazy feature from taking down the entire desktop shell.
 * Reload is intentional: it retries both stale deployment chunks and transient
 * local-resource failures with a fresh module graph.
 */
export class FeatureBoundary extends Component<
  FeatureBoundaryProps,
  FeatureBoundaryState
> {
  state: FeatureBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): FeatureBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`Failed to load ${this.props.name}`, error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <main className="feature-load-state" role="alert">
          <h1>{this.props.name} could not be loaded</h1>
          <p>The application shell is still running. Reload to try again.</p>
          <button className="primary" onClick={() => window.location.reload()}>
            Reload application
          </button>
        </main>
      );
    }

    return (
      <Suspense
        fallback={
          <main className="feature-load-state" role="status" aria-live="polite">
            Loading {this.props.name.toLowerCase()}…
          </main>
        }
      >
        {this.props.children}
      </Suspense>
    );
  }
}
