import { Component, type ReactNode } from "react";
import type { PanelProps, RegisteredPanel } from "./service";

// Pages own placement and closing; this boundary contains a plugin's render errors.
export function PanelView({
  panel,
  ...props
}: PanelProps & { panel: RegisteredPanel }) {
  const Content = panel.component;
  return (
    <PanelBoundary key={`${panel.key}:${panel.revision}:${props.target}`}>
      <Content {...props} />
    </PanelBoundary>
  );
}

class PanelBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error: String(error) };
  }
  render() {
    return this.state.error ? (
      <div role="alert" className="notice">
        <h3>This panel couldn’t open</h3>
        <p>{this.state.error}</p>
      </div>
    ) : (
      this.props.children
    );
  }
}
