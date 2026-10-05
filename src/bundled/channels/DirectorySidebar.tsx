import {
  useCallback,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  ChannelThreadDirectory,
  ChannelThreadSidebarProps,
  ContributionReader,
} from "../../features/conversation/contracts";
import {
  ContributionBoundary,
  contributionKey,
} from "../../features/conversation/ContributionBoundary";
import type { Contribution } from "../../plugins/contributions";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";

import type { Navigation } from "../../features/navigation/controller";

const absentSubscription = () => () => {};
const absentEpoch = () => undefined;

export function directoryAccess(session: RelaySession, channelId: string) {
  const list = session.channels.list();
  const channel = list.channels.find(
    (item) => item.id === channelId && !item.archived,
  );
  if (
    list.status !== "ready" ||
    !channel ||
    !["stream", "forum"].includes(channel.channelType ?? "") ||
    (channel.members !== undefined &&
      (!session.viewer || !channel.members.includes(session.viewer)))
  )
    return undefined;
  return JSON.stringify([session.viewer, channel.members ?? null]);
}

/** Each mounted contribution gets revoked commands, never channel privileges.
 * No window subscriptions or preparation on hover/focus. */
export function DirectorySidebar({
  entry,
  registry,
  relay,
  session,
  scope,
  channelId,
  channelName,
  isCurrent,
  open,
  selectedRootId,
  directorySelected,
}: {
  entry: Contribution<ChannelThreadDirectory>;
  registry: ContributionReader<ChannelThreadDirectory>;
  relay: RelayData;
  session: RelaySession;
  scope: string;
  channelId: string;
  channelName: string;
  isCurrent(): boolean;
  open(
    entry: Contribution<ChannelThreadDirectory>,
    channelId: string,
    rootId?: string,
  ): boolean;
  selectedRootId?: string | undefined;
  directorySelected: boolean;
}) {
  const [commands, setCommands] =
    useState<Pick<ChannelThreadSidebarProps, "openThread" | "openDirectory">>();
  const liveSnapshot = useCallback(
    () => session.live.snapshot().status,
    [session],
  );
  const liveStatus = useSyncExternalStore(session.live.subscribe, liveSnapshot);
  const retainedEpoch = useSyncExternalStore(
    session.channels.subscribeRetained ?? absentSubscription,
    session.channels.retainedEpoch ?? absentEpoch,
  );
  const accessSnapshot = useCallback(
    () => directoryAccess(session, channelId),
    [session, channelId],
  );
  const access = useSyncExternalStore(
    session.channels.subscribeList,
    accessSnapshot,
  );
  useLayoutEffect(() => {
    const connection = relay.snapshot();
    const epoch = retainedEpoch;
    const live = liveStatus;
    let active = true;
    const valid = () =>
      active &&
      isCurrent() &&
      registry.snapshot().includes(entry) &&
      relay.snapshot().status === "ready" &&
      relay.snapshot().generation === connection.generation &&
      relay.snapshot().session === session &&
      relay.snapshot().scope === scope &&
      access !== undefined &&
      directoryAccess(session, channelId) === access &&
      session.channels.retainedEpoch?.() === epoch &&
      session.live.snapshot().status === live &&
      live === "connected";
    const check = () => {
      if (!valid()) active = false;
    };
    const stops = [
      registry.subscribe(check),
      relay.subscribe(check),
      session.channels.subscribeList(check),
      session.live.subscribe(check),
      session.channels.subscribeRetained?.(check) ?? (() => {}),
    ];
    setCommands({
      openDirectory: () => valid() && open(entry, channelId),
      openThread: (root) =>
        valid() && /^[0-9a-f]{64}$/.test(root) && open(entry, channelId, root),
    });
    return () => {
      active = false;
      for (const stop of stops) stop();
    };
  }, [
    access,
    retainedEpoch,
    liveStatus,
    entry,
    registry,
    relay,
    session,
    scope,
    channelId,
    isCurrent,
    open,
  ]);
  const Sidebar = entry.sidebar;
  return Sidebar && commands ? (
    <ContributionBoundary key={contributionKey(entry)} fallback={null}>
      <Sidebar
        session={session}
        scope={scope}
        channelId={channelId}
        channelName={channelName}
        selectedRootId={selectedRootId}
        directorySelected={directorySelected}
        {...commands}
      />
    </ContributionBoundary>
  ) : null;
}

export type SidebarIntent = {
  entry: Contribution<ChannelThreadDirectory>;
  rootId?: string | undefined;
  focusTarget?: HTMLElement | undefined;
  matches(destination: import("./useChannelDirectories").Destination): boolean;
  valid(): boolean;
  dispose(): void;
};

export type DirectorySelection = {
  session: RelaySession;
  scope: string;
  channelId: string;
  entry: Contribution<ChannelThreadDirectory>;
  rootId?: string | undefined;
};

/** A single local handoff, bound to the normal navigation attempt, not a route. */
export function sidebarDirectoryIntent(
  selection: DirectorySelection,
  registry: ContributionReader<ChannelThreadDirectory>,
  relay: RelayData,
  navigator: Navigation,
  focusTarget?: HTMLElement,
): SidebarIntent {
  const { session, scope, channelId, entry, rootId } = selection;
  const connection = relay.snapshot();
  const attempt = navigator.snapshot().attempt;
  const access = directoryAccess(session, channelId);
  const epoch = session.channels.retainedEpoch?.();
  let active = true;
  const valid = () =>
    active &&
    navigator.snapshot().attempt === attempt &&
    !attempt.signal.aborted &&
    registry.snapshot().includes(entry) &&
    relay.snapshot().status === "ready" &&
    relay.snapshot().session === session &&
    relay.snapshot().scope === scope &&
    relay.snapshot().generation === connection.generation &&
    access !== undefined &&
    directoryAccess(session, channelId) === access &&
    session.channels.retainedEpoch?.() === epoch &&
    session.live.snapshot().status === "connected";
  const check = () => {
    if (!valid()) dispose();
  };
  const stops = [
    registry.subscribe(check),
    relay.subscribe(check),
    navigator.subscribe(check),
    session.channels.subscribeList(check),
    session.live.subscribe(check),
    session.channels.subscribeRetained?.(check) ?? (() => {}),
  ];
  function dispose() {
    active = false;
    for (const stop of stops) stop();
  }
  return {
    entry,
    rootId,
    focusTarget,
    valid,
    dispose,
    matches: (destination) =>
      destination.session === session &&
      destination.scope === scope &&
      destination.channelId === channelId &&
      destination.entryId === attempt.entry.id &&
      !destination.signal?.aborted,
  };
}
