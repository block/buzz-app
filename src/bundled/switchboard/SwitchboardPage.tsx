import {
  useCallback,
  useEffect,
  useReducer,
  useState,
  useSyncExternalStore,
} from "react";
import type { Agents } from "../../features/agents/service";
import type { Navigation } from "../../features/navigation/controller";
import type { NavigationScope } from "../../features/navigation/targets";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { ArchiveIcon, ArchiveOffIcon } from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { formatPublicKey } from "../../shared/identity/public-key";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import { subscribeView, viewRevision } from "../../shared/view-state";
import {
  archiveKey,
  isArchived,
  readArchives,
  sessionRows,
  targetOf,
  updateArchive,
  type Row,
} from "./model";
import styles from "./Switchboard.module.css";

type Show = "active" | "archived";
const shows = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
] as const;
const header = <PanelHeader title={<PanelHeaderLabel title="Switchboard" />} />;

export function SwitchboardPage({
  relay,
  agents,
  navigator,
}: {
  relay: RelayData;
  agents: Agents;
  navigator: Navigation;
}) {
  const connection = useRelayConnection(relay);
  const { viewer, scope } = connection;
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Switchboard">
        <div data-buzz-ui="" className={styles.page}>
          {header}
          {connection.status === "ready" &&
          viewer &&
          scope?.endsWith(`:${viewer}`) ? (
            <SwitchboardView
              key={`${scope}:${connection.generation}`}
              session={connection.session}
              partition={scope}
              scope={{
                viewer,
                communityOrigin: scope.slice(0, -(viewer.length + 1)),
              }}
              agents={agents}
              navigator={navigator}
            />
          ) : (
            <div className={styles.notice} role="status">
              <p className="text-body text-subtle">
                {connection.status === "connecting"
                  ? "Connecting…"
                  : (connection.error ??
                    "Choose a community to see its agent sessions.")}
              </p>
              {connection.status === "error" && (
                <Button onClick={relay.retry}>Retry connection</Button>
              )}
            </div>
          )}
        </div>
      </FullPageSurface>
    </div>
  );
}

function SwitchboardView({
  session,
  partition,
  scope,
  agents,
  navigator,
}: {
  session: RelaySession;
  partition: string;
  scope: NavigationScope;
  agents: Agents;
  navigator: Navigation;
}) {
  // Sessions are read on render; every source they come from re-renders.
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const types = agents.types();
  useEffect(() => {
    const stops = [
      agents.subscribe(refresh),
      ...types.flatMap((type) => type.sessions?.subscribe(refresh) ?? []),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [agents, types]);
  const { channels } = useChannelList(session.channels);
  const subscribe = useCallback(
    (listener: () => void) => subscribeView(partition, listener),
    [partition],
  );
  const archives = readArchives(
    useSyncExternalStore(subscribe, () => viewRevision(partition, archiveKey)),
  );
  const [show, setShow] = useState<Show>("active");
  const [error, setError] = useState("");
  const rows = sessionRows(agents).filter(
    (row) => isArchived(archives, row) === (show === "archived"),
  );
  const archive = (row: Row, value: boolean) => {
    try {
      updateArchive(partition, row, value);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const name = (pubkey: string) =>
    agents.find(pubkey)?.name ??
    session.profiles.snapshot().get(pubkey)?.name ??
    formatPublicKey(pubkey);
  return (
    <>
      <div className={styles.toolbar}>
        <Tabs
          variant="panel"
          label="Sessions"
          items={shows}
          value={show}
          onValueChange={setShow}
        />
      </div>
      <div className={styles.scroll}>
        {error && (
          <p role="alert" className={`text-body-sm ${styles.notice}`}>
            {error}
          </p>
        )}
        {rows.length ? (
          <ul
            className={styles.list}
            aria-label={
              show === "archived" ? "Archived sessions" : "Active sessions"
            }
          >
            {rows.map((row) => {
              const { agent, session: item } = row;
              const channel = channels.find((c) => c.id === item.channelId);
              const title =
                channel?.channelType === "dm"
                  ? `DM · ${(channel.participants ?? []).map(name).join(", ") || "Notes to self"}`
                  : channel?.channelType === "session"
                    ? (channel.name ?? "Me")
                    : channel?.name
                      ? `#${channel.name}`
                      : "Conversation";
              const archived = show === "archived";
              const details = [
                agent.name,
                item.root && "Thread",
                item.status,
              ].filter(Boolean);
              return (
                <li key={row.id} className={styles.row}>
                  <NavigationItem
                    aria-label={`Open ${agent.name} in ${title}`}
                    icon={
                      <Avatar
                        size="default"
                        alt=""
                        fallback={agent.name}
                        src={agent.picture && session.media(agent.picture)}
                        shape="squircle"
                      />
                    }
                    label={
                      <span className={styles.content}>
                        <span className={styles.heading}>
                          <strong
                            className={`text-label-sm text-standard ${styles.title}`}
                          >
                            {title}
                          </strong>
                          {item.at !== undefined && (
                            <time
                              className="text-caption text-subtle"
                              dateTime={new Date(item.at).toISOString()}
                            >
                              {relativeTimestamp(item.at / 1000)}
                            </time>
                          )}
                        </span>
                        <span className="text-caption text-subtle">
                          {details.join(" · ")}
                        </span>
                      </span>
                    }
                    onClick={() =>
                      void navigator.open(targetOf(scope, item, channel))
                    }
                  />
                  <span className={styles.rowArchive}>
                    <IconButton
                      size="sm"
                      aria-label={`${archived ? "Restore" : "Archive"} ${agent.name} in ${title}`}
                      title={archived ? "Restore" : "Archive"}
                      onClick={() => archive(row, !archived)}
                      icon={
                        archived ? (
                          <ArchiveOffIcon size={16} aria-hidden="true" />
                        ) : (
                          <ArchiveIcon size={16} aria-hidden="true" />
                        )
                      }
                    />
                  </span>
                </li>
              );
            })}
          </ul>
        ) : show === "archived" ? (
          <EmptyState
            icon={<ArchiveIcon size={24} />}
            title="No archived sessions"
            description="Archived sessions return here until their agent starts another turn."
          />
        ) : (
          <EmptyState
            icon={<ArchiveIcon size={24} />}
            title="No agent sessions"
            description="A session appears here once one of your Codex agents on this device is mentioned."
          />
        )}
      </div>
    </>
  );
}
