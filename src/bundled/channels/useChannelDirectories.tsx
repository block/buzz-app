import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import type { Contribution } from "../../plugins/contributions";
import type {
  ChannelThreadAccessoryProps,
  ChannelThreadDirectory,
  ChannelThreadDirectoryProps,
  ChannelThreadDraftProps,
  ContributionReader,
} from "../../features/conversation/contracts";
import {
  ContributionBoundary,
  contributionKey,
} from "../../features/conversation/ContributionBoundary";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./ChannelDirectories.module.css";
import { messageViewKey } from "../../features/messages/view-key";
import type { SidebarIntent, DirectorySelection } from "./DirectorySidebar";

const empty: readonly Contribution<ChannelThreadDirectory>[] = [];
const absent: ContributionReader<ChannelThreadDirectory> = {
  snapshot: () => empty,
  subscribe: () => () => {},
};
export type Destination = {
  session: RelaySession;
  scope: string;
  channelId: string;
  entryId?: string | undefined;
  signal?: AbortSignal | undefined;
  isCurrent?(): boolean;
};
type Opening = {
  entry: Contribution<ChannelThreadDirectory>;
  destination: Destination;
  generation: number;
  access: string;
  connection: string;
  retainedEpoch?: number | undefined;
  rootId?: string;
  draft?: true;
  unavailable?: true;
  focusId?: string;
  focusTarget?: HTMLElement | undefined;
};

/** Local presentation only. No directory discovery, thread readers or route writes. */
export function useChannelDirectories({
  registry = absent,
  relay,
  destination,
  channelName,
  renderThread,
  onSelect,
  shareReference,
  openInThread,
  sidebarIntent,
  onSelection,
}: {
  registry?: ContributionReader<ChannelThreadDirectory> | undefined;
  relay: RelayData;
  destination: Destination | undefined;
  channelName: string;
  renderThread(
    rootId: string,
    close: () => void,
    share: (title: string) => string | undefined,
    accessory?: (props: ChannelThreadAccessoryProps) => ReactNode,
    onOpenInThread?: () => void,
  ): ReactNode;
  openInThread?(rootId: string): void;
  shareReference?(rootId: string, title: string): string | undefined;
  onSelect(): void;
  sidebarIntent?: SidebarIntent | undefined;
  onSelection?:
    | ((selection: DirectorySelection | undefined) => void)
    | undefined;
}) {
  const entries = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const [opening, setOpening] = useState<Opening>();
  const active = useRef<Opening>(undefined);
  const installed = useRef<{
    destination: Destination | undefined;
    registry: typeof registry;
    relay: RelayData;
  }>(undefined);
  const current = useRef<Destination>(undefined);
  const container = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const restore = useRef<string>(undefined);
  const restoreTarget = useRef<HTMLElement>(undefined);
  const commandEpoch = useRef(0);
  const update = useCallback((next: Opening | undefined) => {
    commandEpoch.current += 1;
    active.current = next;
    setOpening(next);
  }, []);
  const access = useCallback(
    (target: Destination) => {
      const list = target.session.channels.list();
      const channel = list.channels.find(
        (item) => item.id === target.channelId && !item.archived,
      );
      const { viewer } = relay.snapshot();
      // Preserve the existing visibility of listed channels with unknown rosters.
      // A known roster must include the current viewer; presence of a retained
      // summary alone is not a grant. The actual thread reader stays authoritative.
      if (
        list.status !== "ready" ||
        !channel ||
        (channel.channelType !== "stream" && channel.channelType !== "forum") ||
        (channel.members !== undefined &&
          (!viewer || !channel.members.includes(viewer)))
      )
        return "unavailable";
      return JSON.stringify([viewer, channel.members ?? null]);
    },
    [relay],
  );
  const valid = useCallback(
    (value: Opening) => {
      const connection = relay.snapshot();
      return (
        active.current === value &&
        !value.unavailable &&
        current.current === value.destination &&
        !value.destination.signal?.aborted &&
        value.destination.isCurrent?.() !== false &&
        registry.snapshot().includes(value.entry) &&
        connection.status === "ready" &&
        connection.session === value.destination.session &&
        connection.scope === value.destination.scope &&
        connection.generation === value.generation &&
        access(value.destination) === value.access &&
        (value.retainedEpoch === undefined ||
          value.destination.session.channels.retainedEpoch?.() ===
            value.retainedEpoch) &&
        value.destination.session.live.snapshot().status === value.connection
      );
    },
    [registry, relay, access],
  );
  useLayoutEffect(() => {
    current.current = destination;
    // StrictMode effect replay must not consume an already handed-off intent twice.
    if (
      installed.current?.destination !== destination ||
      installed.current?.registry !== registry ||
      installed.current?.relay !== relay
    )
      update(undefined);
    installed.current = { destination, registry, relay };
    const check = () => {
      const value = active.current;
      if (value && !value.unavailable && !valid(value))
        update({ ...value, unavailable: true });
    };
    const stops =
      destination && registry !== absent
        ? [
            registry.subscribe(check),
            relay.subscribe(check),
            destination.session.channels.subscribeList(check),
            destination.session.live.subscribe(check),
            destination.session.channels.subscribeRetained?.(check) ??
              (() => {}),
          ]
        : [];
    destination?.signal?.addEventListener("abort", check);
    return () => {
      current.current = undefined;
      destination?.signal?.removeEventListener("abort", check);
      for (const stop of stops) stop();
    };
    // Destination identity changes only at a host navigation/session boundary.
  }, [destination, registry, relay, valid, update]);
  useLayoutEffect(() => {
    if (!sidebarIntent || !destination || !sidebarIntent.matches(destination))
      return;
    if (sidebarIntent.valid()) {
      onSelect();
      const connection = relay.snapshot();
      update({
        entry: sidebarIntent.entry,
        destination,
        generation: connection.generation,
        access: access(destination),
        connection: destination.session.live.snapshot().status,
        retainedEpoch: destination.session.channels.retainedEpoch?.(),
        ...(sidebarIntent.rootId
          ? {
              rootId: sidebarIntent.rootId,
              focusTarget: sidebarIntent.focusTarget,
            }
          : {}),
      });
    }
    sidebarIntent.dispose();
  }, [sidebarIntent, destination, relay, access, update, onSelect]);
  const restoreFocus = () => {
    if (
      restore.current === undefined ||
      opening?.rootId ||
      opening?.draft ||
      opening?.unavailable
    )
      return;
    const control = document.getElementById(restore.current);
    restore.current = undefined;
    const origin = restoreTarget.current;
    restoreTarget.current = undefined;
    const focus = (target: HTMLElement | null | undefined) => {
      if (
        !target?.isConnected ||
        target.closest('[hidden], [inert], [aria-hidden="true"]') ||
        target.matches(":disabled") ||
        !target.getClientRects().length ||
        getComputedStyle(target).visibility !== "visible"
      )
        return false;
      target.focus();
      return document.activeElement === target;
    };
    if (focus(origin)) return;
    if (control && container.current?.contains(control) && focus(control))
      return;
    focus(tabs.current?.querySelector<HTMLElement>("[aria-selected='true']"));
  };
  const selected = opening?.destination === destination ? opening : undefined;
  useLayoutEffect(() => {
    onSelection?.(
      selected && !selected.unavailable
        ? {
            session: selected.destination.session,
            scope: selected.destination.scope,
            channelId: selected.destination.channelId,
            entry: selected.entry,
            rootId: selected.rootId,
          }
        : undefined,
    );
    return () => onSelection?.(undefined);
  }, [selected, onSelection]);
  const returnToChannel = () => {
    update(undefined);
    tabs.current
      ?.querySelector<HTMLElement>("[data-tab-value='channel']")
      ?.focus();
  };
  const unavailable = (title: string) => (
    <div className={styles.notice} role="status">
      <p>{title} unavailable. Return to Channel to continue.</p>
      <Button onClick={returnToChannel}>Return to Channel</Button>
    </div>
  );
  const ordered = [...entries].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  const items = [
    { value: "channel", label: "Channel" },
    ...ordered.map((entry) => ({ value: entry.key, label: entry.title })),
  ];
  if (selected && !items.some((item) => item.value === selected.entry.key))
    items.push({ value: selected.entry.key, label: selected.entry.title });
  const openThread = useCallback<ChannelThreadDirectoryProps["openThread"]>(
    (rootId) => {
      if (
        !selected ||
        !valid(selected) ||
        typeof rootId !== "string" ||
        !/^[0-9a-f]{64}$/.test(rootId)
      )
        return false;
      update({
        ...selected,
        rootId,
        focusId:
          document.activeElement instanceof HTMLElement
            ? document.activeElement.id
            : "",
      });
      return true;
    },
    [selected, valid, update],
  );
  function select(
    entry: Contribution<ChannelThreadDirectory> | undefined,
    draft = false,
  ) {
    if (!destination) return;

    const connection = relay.snapshot();
    if (
      !entry ||
      !registry.snapshot().includes(entry) ||
      current.current !== destination ||
      destination.isCurrent?.() === false ||
      destination.signal?.aborted ||
      connection.status !== "ready" ||
      connection.session !== destination.session ||
      connection.scope !== destination.scope ||
      access(destination) === "unavailable"
    )
      return;
    onSelect();
    update({
      entry,
      destination,
      generation: connection.generation,
      access: access(destination),
      connection: destination.session.live.snapshot().status,
      ...(draft ? { draft: true as const } : {}),
    });
  }
  const back = useCallback(() => {
    if (!selected || !valid(selected)) return false;
    const { draft: _draft, rootId: _root, ...directory } = selected;
    restore.current = "";
    update(directory);
    return true;
  }, [selected, valid, update]);
  return {
    entries,
    selectedEntry: selected?.entry,
    selectedRootId: selected?.rootId,
    /** Capture the exact registration/destination even when no tab was selected.
     * Any subsequent tab/navigation/access/connection transition retires it. */
    commandLease() {
      const entry = registry
        .snapshot()
        .find(
          (item) =>
            item.pluginId === "buzz.sessions" &&
            item.id === "sessions" &&
            item.create,
        );
      if (!destination || !entry || active.current) return undefined;
      const connection = relay.snapshot();
      const captured = access(destination);
      const epoch = commandEpoch.current;
      const live = destination.session.live.snapshot().status;
      const validCommand = () =>
        commandEpoch.current === epoch &&
        current.current === destination &&
        !destination.signal?.aborted &&
        destination.isCurrent?.() !== false &&
        registry.snapshot().includes(entry) &&
        relay.snapshot().status === "ready" &&
        relay.snapshot().session === destination.session &&
        relay.snapshot().scope === destination.scope &&
        relay.snapshot().generation === connection.generation &&
        captured !== "unavailable" &&
        access(destination) === captured &&
        destination.session.live.snapshot().status === live &&
        live === "connected";
      if (!validCommand()) return undefined;
      // Latch transitions, including disconnect/reconnect or removal/re-addition.
      let retained = true;
      const check = () => {
        if (!validCommand()) retained = false;
      };
      const stops = [
        registry.subscribe(check),
        relay.subscribe(check),
        destination.session.channels.subscribeList(check),
        destination.session.live.subscribe(check),
      ];
      destination.signal?.addEventListener("abort", check);
      return {
        valid: () => retained && validCommand(),
        dispose() {
          retained = false;
          for (const stop of stops) stop();
          destination.signal?.removeEventListener("abort", check);
        },
        open(rootId: string) {
          if (!retained || !validCommand() || !/^[0-9a-f]{64}$/.test(rootId))
            return false;
          onSelect();
          update({
            entry,
            destination,
            rootId,
            generation: connection.generation,
            access: captured,
            connection: live,
          });
          return true;
        },
      };
    },
    selected: !!selected,
    launchers:
      !selected?.rootId &&
      !selected?.draft &&
      destination &&
      ordered
        .filter((entry) => entry.create)
        .map((entry) => (
          <Button
            key={entry.key}
            size="compact"
            onClick={() => select(entry, true)}
          >
            {entry.create?.title}
          </Button>
        )),
    tabs: destination && (entries.length > 0 || selected) && (
      <div ref={tabs} className={styles.tabs}>
        <Tabs
          variant="workspace"
          label="Channel views"
          value={selected?.entry.key ?? "channel"}
          items={items}
          onValueChange={(key) => {
            if (key === "channel") {
              returnToChannel();
              return;
            }
            if (selected?.entry.key === key) return;
            select(registry.snapshot().find((item) => item.key === key));
          }}
        />
      </div>
    ),
    content: selected && (
      <div className={styles.content} ref={container}>
        {selected.unavailable || !entries.includes(selected.entry) ? (
          unavailable(selected.entry.title)
        ) : (
          <ContributionBoundary
            key={contributionKey(selected.entry)}
            fallback={unavailable(selected.entry.title)}
          >
            {selected.rootId
              ? renderThread(
                  selected.rootId,
                  () => {
                    if (!valid(selected)) return;
                    restore.current = selected.focusId ?? "";
                    restoreTarget.current = selected.focusTarget;
                    const {
                      rootId: _root,
                      draft: _draft,
                      ...directory
                    } = selected;
                    update(directory);
                  },
                  (title) => {
                    if (!valid(selected) || !shareReference || !selected.rootId)
                      return "This session is no longer available. Return to Channel and try again.";
                    const failure = shareReference(selected.rootId, title);
                    if (failure) return failure;
                    update(undefined);
                    return undefined;
                  },
                  selected.entry.threadAccessory
                    ? (props) => {
                        if (
                          !valid(selected) ||
                          props.session !== selected.destination.session ||
                          props.scope !== selected.destination.scope ||
                          props.channelId !== selected.destination.channelId ||
                          props.threadRootId !== selected.rootId
                        )
                          return null;
                        const Accessory = selected.entry.threadAccessory;
                        if (!Accessory) return null;
                        return (
                          <ContributionBoundary
                            key={`${contributionKey(selected.entry)}:${messageViewKey(props.session, props.scope, props.channelId, props.threadRootId)}`}
                            fallback={
                              <p role="status">Agent activity unavailable</p>
                            }
                          >
                            <Accessory {...props} />
                          </ContributionBoundary>
                        );
                      }
                    : undefined,
                  openInThread
                    ? () => {
                        if (!valid(selected) || !selected.rootId) return;
                        update(undefined);
                        openInThread(selected.rootId);
                      }
                    : undefined,
                )
              : destination && (
                  <OwnedDirectory
                    key={selected.draft ? "draft" : "directory"}
                    draft={!!selected.draft}
                    back={back}
                    entry={selected.entry}
                    restoreFocus={restoreFocus}
                    session={destination.session}
                    scope={destination.scope}
                    channelId={destination.channelId}
                    channelName={channelName}
                    openThread={openThread}
                  />
                )}
          </ContributionBoundary>
        )}
      </div>
    ),
  };
}

/** A saved command also dies on component failure/unmount, not only tab changes. */
function OwnedDirectory({
  entry,
  restoreFocus,
  draft,
  back,
  ...props
}: ChannelThreadDirectoryProps & {
  entry: Contribution<ChannelThreadDirectory>;
  restoreFocus(): void;
  draft: boolean;
  back: ChannelThreadDraftProps["back"];
}) {
  const [command, setCommand] = useState<{
    openThread: ChannelThreadDirectoryProps["openThread"];
    back: ChannelThreadDraftProps["back"];
  }>();
  useLayoutEffect(() => {
    let mounted = true;
    setCommand({
      openThread: (id) => mounted && props.openThread(id),
      back: () => mounted && back(),
    });
    return () => {
      mounted = false;
    };
  }, [props.openThread, back]);
  useLayoutEffect(() => {
    if (command) restoreFocus();
  }, [command, restoreFocus]);
  const Directory = entry.component;
  const Draft = entry.create?.component;
  if (draft && Draft) return command ? <Draft {...props} {...command} /> : null;
  return command ? (
    <Directory {...props} openThread={command.openThread} />
  ) : null;
}
