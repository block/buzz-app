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
  ChannelThreadDirectory,
  ChannelThreadDirectoryProps,
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

const empty: readonly Contribution<ChannelThreadDirectory>[] = [];
const absent: ContributionReader<ChannelThreadDirectory> = {
  snapshot: () => empty,
  subscribe: () => () => {},
};
type Destination = {
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
  rootId?: string;
  unavailable?: true;
  focusId?: string;
};

/** Local presentation only. No directory discovery, thread readers or route writes. */
export function useChannelDirectories({
  registry = absent,
  relay,
  destination,
  channelName,
  renderThread,
  onSelect,
}: {
  registry?: ContributionReader<ChannelThreadDirectory> | undefined;
  relay: RelayData;
  destination: Destination | undefined;
  channelName: string;
  renderThread(rootId: string, close: () => void): ReactNode;
  onSelect(): void;
}) {
  const entries = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const [opening, setOpening] = useState<Opening>();
  const active = useRef<Opening>(undefined);
  const current = useRef<Destination>(undefined);
  const container = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const restore = useRef<string>(undefined);
  const update = useCallback((next: Opening | undefined) => {
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
        value.destination.session.live.snapshot().status === value.connection
      );
    },
    [registry, relay, access],
  );
  useLayoutEffect(() => {
    current.current = destination;
    update(undefined);
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
          ]
        : [];
    destination?.signal?.addEventListener("abort", check);
    return () => {
      current.current = undefined;
      active.current = undefined;
      destination?.signal?.removeEventListener("abort", check);
      for (const stop of stops) stop();
    };
    // Destination identity changes only at a host navigation/session boundary.
  }, [destination, registry, relay, valid, update]);
  const restoreFocus = () => {
    if (
      restore.current === undefined ||
      opening?.rootId ||
      opening?.unavailable
    )
      return;
    const control = document.getElementById(restore.current);
    restore.current = undefined;
    if (control && container.current?.contains(control)) control.focus();
    else
      tabs.current
        ?.querySelector<HTMLElement>("[aria-selected='true']")
        ?.focus();
  };
  const selected = opening?.destination === destination ? opening : undefined;
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
  return {
    selected: !!selected,
    tabs: destination && (entries.length > 0 || selected) && (
      <div ref={tabs} className={styles.tabs}>
        <Tabs
          variant="panel"
          label="Channel views"
          value={selected?.entry.key ?? "channel"}
          items={items}
          onValueChange={(key) => {
            if (key === "channel") {
              returnToChannel();
              return;
            }
            if (selected?.entry.key === key) return;
            const entry = registry.snapshot().find((item) => item.key === key);
            const connection = relay.snapshot();
            if (
              !entry ||
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
            });
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
              ? renderThread(selected.rootId, () => {
                  if (!valid(selected)) return;
                  restore.current = selected.focusId ?? "";
                  const { rootId: _root, ...directory } = selected;
                  update(directory);
                })
              : destination && (
                  <OwnedDirectory
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
  ...props
}: ChannelThreadDirectoryProps & {
  entry: Contribution<ChannelThreadDirectory>;
  restoreFocus(): void;
}) {
  const [command, setCommand] = useState<{
    openThread: ChannelThreadDirectoryProps["openThread"];
  }>();
  useLayoutEffect(() => {
    let mounted = true;
    setCommand({ openThread: (id) => mounted && props.openThread(id) });
    return () => {
      mounted = false;
    };
  }, [props.openThread]);
  useLayoutEffect(() => {
    if (command) restoreFocus();
  }, [command, restoreFocus]);
  const Directory = entry.component;
  return command ? (
    <Directory {...props} openThread={command.openThread} />
  ) : null;
}
