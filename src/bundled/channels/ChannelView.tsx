import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  ChannelView,
  ContributionReader,
} from "../../features/conversation/contracts";
import type { PageNavigation } from "../../features/navigation/service";
import type { Navigation } from "../../features/navigation/controller";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { resolveMatch, type Contribution } from "../../plugins/contributions";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Button } from "../../shared/design-system/ui/Button";
import { PlugIcon } from "../../shared/design-system/icons";
import { PanelFrame } from "../../features/panels/PanelFrame";

const empty: readonly Contribution<ChannelView>[] = [];
const emptyViews: ContributionReader<ChannelView> = {
  snapshot: () => empty,
  subscribe: () => () => {},
};

export function useChannelView(
  registry: ContributionReader<ChannelView> = emptyViews,
  channel: ChannelSummary | undefined,
) {
  const entries = useSyncExternalStore(registry.subscribe, registry.snapshot);
  return channel ? resolveMatch(entries, channel) : undefined;
}

export function SelectedChannelView({
  entry,
  registry,
  channel,
  session,
  relay,
  navigation,
  navigator,
  companion,
  companionOpening,
}: {
  entry: Contribution<ChannelView>;
  registry: ContributionReader<ChannelView>;
  channel: ChannelSummary;
  session: RelaySession;
  relay: RelayData;
  navigation?: PageNavigation | undefined;
  navigator: Navigation;
  companion?: ReactNode;
  companionOpening?: object | undefined;
}) {
  const [retry, setRetry] = useState(0);
  return (
    <OwnedContribution
      entry={entry}
      registry={registry}
      resetIdentity={`${navigation?.entryId}:${retry}`}
      fallback={
        <Unavailable
          navigation={navigation}
          retry={() => setRetry((n) => n + 1)}
          scope={relay.snapshot().scope}
          companion={companion}
        />
      }
    >
      {(view, owned) => (
        <FullPageSurface aria-label={entry.title} style={{ height: "100%" }}>
          <MountedView
            entry={view}
            channel={channel}
            session={session}
            navigation={navigation}
            companion={companion}
            companionOpening={companionOpening}
            active={() => {
              const current = navigator.snapshot().entry;
              return (
                owned() &&
                !navigation?.signal.aborted &&
                relay.snapshot().session === session &&
                current.target.kind === "conversation" &&
                current.target.channelId === channel.id &&
                (!navigation || current.id === navigation.entryId)
              );
            }}
          />
        </FullPageSurface>
      )}
    </OwnedContribution>
  );
}

function MountedView({
  entry,
  channel,
  session,
  active,
  navigation,
  companion,
  companionOpening,
}: {
  entry: Contribution<ChannelView>;
  channel: ChannelSummary;
  session: RelaySession;
  active(): boolean;
  navigation?: PageNavigation | undefined;
  companion?: ReactNode;
  companionOpening?: object | undefined;
}) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    // Layout-effect failures must reach the boundary before entry succeeds.
    queueMicrotask(() => {
      if (navigation?.target.kind === "conversation" && active())
        navigation.complete({ status: "opened" });
    });
  }, [navigation, active]);
  useLayoutEffect(() => {
    if (navigation && navigation.target.kind !== "conversation") return;
    if (
      active() &&
      navigation?.focus !== "preserve" &&
      document.activeElement === document.body
    )
      root.current?.focus({ preventScroll: true });
  }, [navigation, active]);
  const Component = entry.component;
  return (
    <section
      ref={root}
      tabIndex={-1}
      aria-label={entry.title}
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <Component
        session={session}
        channel={channel}
        active={active}
        companion={companion}
        companionOpening={companionOpening}
      />
    </section>
  );
}

function Unavailable({
  navigation,
  retry,
  scope,
  companion,
}: {
  navigation?: PageNavigation | undefined;
  retry(): void;
  scope: string | undefined;
  companion?: ReactNode;
}) {
  useEffect(() => {
    if (navigation?.target.kind !== "conversation") return;
    navigation?.complete({
      status: "failed",
      reason: "unavailable",
      presented: true,
    });
  }, [navigation]);
  return (
    <PanelFrame scope={scope} companion={companion}>
      <FullPageSurface>
        <EmptyState
          icon={<PlugIcon />}
          title="Channel view unavailable"
          description="Try the view again, or open another channel."
          action={<Button onClick={retry}>Retry</Button>}
        />
      </FullPageSurface>
    </PanelFrame>
  );
}
