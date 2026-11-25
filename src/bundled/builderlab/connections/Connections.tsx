import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  PlusIcon,
  PlugIcon,
  WarningCircleIcon,
} from "../../../shared/design-system/icons";
import { AlertDialog } from "../../../shared/design-system/ui/AlertDialog";
import { Avatar } from "../../../shared/design-system/ui/Avatar";
import { Button } from "../../../shared/design-system/ui/Button";
import { EmptyState } from "../../../shared/design-system/ui/EmptyState";
import { SearchField } from "../../../shared/design-system/ui/SearchField";
import type { OverviewObserver } from "../overview";
import type { BuilderlabSession } from "../session";
import type { Connection } from "./client";
import {
  connectionLabel,
  connectionStatus,
  sortConnections,
  type ConnectionStatus,
} from "./status";
import type { ConnectionsStore } from "./store";
import styles from "./Connections.module.css";

/** Past this many, a search narrows the list. */
const SEARCH_FROM = 8;

function StatusText({ status }: { status: ConnectionStatus }) {
  return status.kind === "expired" ? (
    <span className="text-danger">Expired</span>
  ) : status.kind === "expiring" ? (
    <span className="text-warning">{status.label}</span>
  ) : (
    <span className="text-subtle">Connected</span>
  );
}

export function Connections({
  store,
  session,
  active,
  openPage,
  onOverview,
  now = Date.now,
}: {
  store: ConnectionsStore;
  session: BuilderlabSession;
  active(): boolean;
  /** The account's connections page, or one connection's sign-in there. */
  openPage(name?: string): void;
  onOverview?: OverviewObserver | undefined;
  now?: () => number;
}) {
  const login = useSyncExternalStore(session.subscribe, session.snapshot);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const activeRef = useRef(active);
  activeRef.current = active;
  const signedIn = login.status === "signed-in";
  // The card counts what the list shows, from the same read.
  useLayoutEffect(() => {
    if (!active() || !onOverview) return;
    if (!signedIn) return onOverview({ kind: "empty" });
    if (!state.connections)
      return onOverview({ kind: state.error ? "failed" : "pending" });
    const at = now();
    const needed = state.connections.filter(
      (c) => connectionStatus(c, at).kind !== "connected",
    ).length;
    const connected = state.connections.length - needed;
    onOverview(
      state.connections.length
        ? {
            kind: "filled",
            items: [
              ...(needed
                ? [
                    {
                      key: "attention",
                      label:
                        needed === 1
                          ? "1 needs attention"
                          : `${needed} need attention`,
                    },
                  ]
                : []),
              ...(connected
                ? [{ key: "connected", label: `${connected} connected` }]
                : []),
            ],
          }
        : { kind: "empty" },
    );
  }, [active, onOverview, now, signedIn, state]);
  // Coming back from the browser re-reads, so a reconnect shows at once.
  useEffect(() => {
    if (!signedIn) return;
    const focus = () => {
      if (activeRef.current()) void store.refresh();
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [store, signedIn]);
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  if (!signedIn) return null;
  const at = now();
  const all = state.connections
    ? sortConnections(state.connections, at)
    : undefined;
  const needed =
    all?.filter((c) => connectionStatus(c, at).kind !== "connected").length ??
    0;
  const search = query.trim().toLowerCase();
  const shown = search
    ? all?.filter((c) => connectionLabel(c.name).toLowerCase().includes(search))
    : all;
  return (
    <section aria-label="Connections" className="flex flex-col gap-3">
      <div className={styles.intro}>
        <p className="m-0 text-body-sm text-secondary">
          Apps and services your agents use on your behalf. Reconnect one before
          it expires to keep them working.
        </p>
        <Button
          variant="outline"
          onClick={() => {
            if (active()) openPage();
          }}
        >
          <PlusIcon aria-hidden="true" /> Add connection
        </Button>
      </div>
      {needed > 0 && (
        <p role="status" className={`${styles.attention} text-body-sm`}>
          <WarningCircleIcon aria-hidden="true" size={16} />
          {needed === 1
            ? "1 connection needs attention"
            : `${needed} connections need attention`}
        </p>
      )}
      {(all?.length ?? 0) > SEARCH_FROM && (
        <SearchField
          value={query}
          onValueChange={setQuery}
          label="Search connections"
          placeholder="Search connections"
        />
      )}
      {!all && !state.error && (
        <p role="status" className="m-0 text-body-sm text-secondary">
          Loading connections…
        </p>
      )}
      {state.error && (
        <div role="alert">
          <EmptyState
            icon={<PlugIcon />}
            title="Couldn’t load connections"
            description={state.error}
            action={
              <Button
                variant="subtle"
                loading={state.loading}
                onClick={() => void store.refresh()}
              >
                Try again
              </Button>
            }
            level={4}
          />
        </div>
      )}
      {all?.length === 0 && (
        <EmptyState
          icon={<PlugIcon />}
          title="No connections yet"
          description="Connect an app so your agents can use it."
          level={4}
        />
      )}
      {shown && shown.length > 0 && (
        <ul className={styles.list} aria-label="Your connections">
          {shown.map((connection) => {
            const status = connectionStatus(connection, at);
            const name = connectionLabel(connection.name);
            return (
              <li key={connection.name} className={styles.row}>
                <span className={styles.icon} aria-hidden="true">
                  <Avatar alt="" fallback={name} size="fill" shape="squircle" />
                </span>
                <span className={styles.name}>
                  <span className="text-body-sm">{name}</span>
                  <span className="text-caption">
                    <StatusText status={status} />
                  </span>
                </span>
                <span className={styles.actions}>
                  <Button
                    variant="ghost"
                    aria-label={`Disconnect ${name}`}
                    onClick={() => {
                      if (!active()) return;
                      setFailure(undefined);
                      setConfirm(connection);
                    }}
                  >
                    Disconnect
                  </Button>
                  <Button
                    variant={
                      status.kind === "connected" ? "ghost" : "prominent"
                    }
                    aria-label={`Reconnect ${name}`}
                    onClick={() => {
                      if (active()) openPage(connection.name);
                    }}
                  >
                    Reconnect
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {shown?.length === 0 && !!all?.length && (
        <p className="m-0 text-body-sm text-secondary">
          No connections match “{query.trim()}”.
        </p>
      )}
      {confirm && (
        <AlertDialog
          title={`Disconnect ${connectionLabel(confirm.name)}?`}
          description="Your agents lose access until you connect it again."
          pending={busy}
          onClose={() => setConfirm(null)}
          {...(failure ? { children: <p role="alert">{failure}</p> } : {})}
          actions={
            <>
              <Button disabled={busy} onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={busy}
                onClick={() => {
                  setBusy(true);
                  setFailure(undefined);
                  store.disconnect(confirm.name).then(
                    () => {
                      setBusy(false);
                      setConfirm(null);
                    },
                    (reason) => {
                      setBusy(false);
                      setFailure(
                        reason instanceof Error
                          ? reason.message
                          : "Couldn’t disconnect.",
                      );
                    },
                  );
                }}
              >
                Disconnect
              </Button>
            </>
          }
        />
      )}
    </section>
  );
}
