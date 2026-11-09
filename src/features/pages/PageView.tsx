import { Component, Fragment, useEffect, type ReactNode } from "react";
import { rawText } from "../relay/user-copy";
import {
  ContributionFailure,
  type FailedPlugin,
  type PluginOwners,
  PluginOwnersProvider,
} from "./ContributionFailure";
import type { PageProps, RegisteredPage } from "./service";

type BoundaryProps = {
  children: ReactNode;
  page: RegisteredPage;
  navigation?: PageProps["navigation"];
  plugin?: FailedPlugin | undefined;
};
class PageBoundary extends Component<
  BoundaryProps,
  {
    failure: { details: string | undefined } | null;
    /** Bumped by Try again so the page remounts with fresh state. */
    attempt: number;
    page: RegisteredPage;
    navigation: PageProps["navigation"];
  }
> {
  state = {
    failure: null as { details: string | undefined } | null,
    attempt: 0,
    page: this.props.page,
    navigation: this.props.navigation,
  };
  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: PageBoundary["state"],
  ) {
    // A new attempt or registration can retry a failed subtree, even within one visit.
    // Do not remount healthy content on a reclick: its local drafts/focus still belong to it.
    if (props.page !== state.page || props.navigation !== state.navigation)
      return { failure: null, page: props.page, navigation: props.navigation };
    return null;
  }
  static getDerivedStateFromError(error: unknown) {
    return { failure: { details: rawText(error) } };
  }
  componentDidCatch() {
    this.props.navigation?.complete({
      status: "failed",
      reason: "unavailable",
    });
  }
  render() {
    const { failure, attempt } = this.state;
    return failure ? (
      <ContributionFailure
        kind="page"
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
export function PageView({
  page,
  companion,
  companionOpening,
  navigation,
  owners,
}: {
  page: RegisteredPage;
  /** Names external plugins, so a failed page or panel can name its own and
   * offer Manage plugin. Without it every failure reads as built-in. */
  owners?: PluginOwners | undefined;
} & PageProps) {
  return (
    <PluginOwnersProvider value={owners}>
      <PageBoundary
        page={page}
        navigation={navigation}
        plugin={owners?.(page.pluginId)}
        key={`${page.key}:${page.revision}`}
      >
        <PresentedPage
          page={page}
          companion={companion}
          companionOpening={companionOpening}
          navigation={navigation}
        />
      </PageBoundary>
    </PluginOwnersProvider>
  );
}
function PresentedPage({
  page,
  companion,
  companionOpening,
  navigation,
}: { page: RegisteredPage } & PageProps) {
  const Page = page.component;
  useEffect(() => {
    // This effect lives INSIDE the boundary: failed rendering never acknowledges mount.
    if (!page.handlesNavigation) navigation?.complete({ status: "opened" });
  }, [page, navigation]);
  return (
    <Page
      companion={companion}
      companionOpening={companionOpening}
      navigation={navigation}
    />
  );
}
