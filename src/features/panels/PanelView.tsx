import { Component, Fragment, type ReactNode } from "react";
import { rawText } from "../relay/user-copy";
import {
  ContributionFailure,
  type FailedPlugin,
} from "../pages/ContributionFailure";
import type { PanelProps, RegisteredPanel } from "./service";

// Pages own placement and closing; this boundary contains a plugin's render errors.
export function PanelView({
  panel,
  contentKey,
  plugin,
  ...props
}: PanelProps & {
  panel: RegisteredPanel;
  /** The external plugin that owns this panel, so a failure can name it. */
  plugin?: FailedPlugin | undefined;
  /** Host-owned identity when several addresses inspect the same content. */
  contentKey?: string | undefined;
}) {
  const Content = panel.component;
  return (
    <PanelBoundary
      plugin={plugin}
      key={`${panel.key}:${panel.revision}:${contentKey ?? props.target}`}
    >
      <Content {...props} />
    </PanelBoundary>
  );
}

class PanelBoundary extends Component<
  { children: ReactNode; plugin?: FailedPlugin | undefined },
  { failure: { details: string | undefined } | null; attempt: number }
> {
  state: {
    failure: { details: string | undefined } | null;
    attempt: number;
  } = { failure: null, attempt: 0 };
  static getDerivedStateFromError(error: unknown) {
    return { failure: { details: rawText(error) } };
  }
  render() {
    const { failure, attempt } = this.state;
    return failure ? (
      <ContributionFailure
        kind="panel"
        plugin={this.props.plugin}
        details={failure.details}
        onRetry={() =>
          this.setState((state) => ({
            failure: null,
            attempt: state.attempt + 1,
          }))
        }
      />
    ) : (
      <Fragment key={attempt}>{this.props.children}</Fragment>
    );
  }
}
