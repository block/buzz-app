import { useCallback, useState, useSyncExternalStore } from "react";
import type { Navigation } from "../../features/navigation/controller";
import { splitPartition } from "../../features/relay/partition";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { ListChecksIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { subscribeView } from "../../shared/view-state";
import { DecisionDialog } from "./DecisionDialog";
import {
  readList,
  remove,
  reset,
  revision,
  sourceKey,
  type Decision,
  type Stage,
} from "./model";
import styles from "./DecisionInbox.module.css";

const groups: readonly { stage: Stage; title: string }[] = [
  { stage: "decision", title: "Awaiting your decision" },
  { stage: "handoff", title: "Decision made · awaiting handoff" },
  { stage: "done", title: "Handed off · done" },
];

function activeScope(connection: RelaySnapshot) {
  if (
    (connection.status !== "ready" && !connection.cached) ||
    connection.denied ||
    !connection.viewer ||
    !connection.scope ||
    connection.session.scope !== connection.scope ||
    connection.session.viewer !== connection.viewer
  )
    return undefined;
  const scope = splitPartition(connection.scope);
  return scope?.viewer === connection.viewer ? scope : undefined;
}

export function DecisionInboxPage({
  relay,
  navigator,
}: {
  relay: RelayData;
  navigator: Navigation;
}) {
  const connection = useRelayConnection(relay);
  const scope = activeScope(connection);
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Decision Inbox">
        {scope && connection.scope ? (
          <ScopedPage
            key={connection.scope}
            relay={relay}
            navigator={navigator}
            partition={connection.scope}
            writable={connection.status === "ready" && !connection.cached}
          />
        ) : (
          <div className={styles.page}>
            <PanelHeader
              title={
                <PanelHeaderLabel
                  title="Decision Inbox"
                  icon={<ListChecksIcon size="1rem" />}
                />
              }
            />
            <div className={styles.scroll}>
              <EmptyState
                icon={<ListChecksIcon />}
                title="Connect to see decisions"
                description="Choose a community to see decisions saved on this device."
              />
            </div>
          </div>
        )}
      </FullPageSurface>
    </div>
  );
}

function ScopedPage({
  relay,
  navigator,
  partition,
  writable,
}: {
  relay: RelayData;
  navigator: Navigation;
  partition: string;
  writable: boolean;
}) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeView(partition, listener),
    [partition],
  );
  const snapshot = useCallback(() => revision(partition), [partition]);
  const savedRevision = useSyncExternalStore(subscribe, snapshot, snapshot);
  const list = readList(savedRevision);
  const [editing, setEditing] = useState<{
    record: Decision;
    revision: string | null | undefined;
  }>();
  const [removing, setRemoving] = useState<{
    record: Decision;
    revision: string | null | undefined;
  }>();
  const [resetting, setResetting] = useState<string>();
  const [error, setError] = useState("");
  const sameScope = () => {
    const connection = relay.snapshot();
    return (
      connection.scope === partition && activeScope(connection) !== undefined
    );
  };
  const current = () => {
    const connection = relay.snapshot();
    return connection.status === "ready" && !connection.cached && sameScope();
  };
  const openSource = (item: Decision) => {
    const scope = splitPartition(partition);
    if (!scope || !sameScope()) return;
    setError("");
    void navigator
      .open({
        version: 1,
        kind: "conversation",
        scope,
        channelId: item.channelId,
        messageId: item.messageId,
        ...(item.threadRootId ? { threadRootId: item.threadRootId } : {}),
      })
      .then((result) => {
        if (result.status === "failed")
          setError("This source message could not be opened.");
      })
      .catch(() => setError("This source message could not be opened."));
  };
  const confirmReset = async () => {
    if (!current()) {
      setError("The account or community changed. Reopen Decision Inbox.");
      return;
    }
    if (resetting === undefined || readList(resetting).status !== "damaged")
      return;
    const expected = resetting;
    setResetting(undefined);
    const result = await reset(partition, expected, current);
    if (result === "saved") {
      setError("");
    } else {
      setError(
        result === "changed"
          ? "The saved list changed in another window. Review the latest version before trying again."
          : result === "scope-changed"
            ? "The account or community changed. Reopen Decision Inbox."
            : result === "unavailable"
              ? "This device cannot safely save decisions from multiple windows."
              : "Could not reset the saved list on this device.",
      );
    }
  };
  const confirmRemove = async () => {
    if (!removing) return;
    setRemoving(undefined);
    if (!current()) {
      setError("The account or community changed. Reopen Decision Inbox.");
      return;
    }
    const result = await remove(
      partition,
      removing.revision,
      removing.record,
      current,
    );
    setError(
      result === "saved"
        ? ""
        : result === "changed"
          ? "The saved list changed in another window. Review the latest version before trying again."
          : result === "scope-changed"
            ? "The account or community changed. Reopen Decision Inbox."
            : result === "unavailable"
              ? "This device cannot safely save decisions from multiple windows."
              : result === "damaged"
                ? "The saved list cannot be read. Recover it before trying again."
                : "Could not remove this decision on this device. Check available storage and try again.",
    );
  };
  return (
    <div className={styles.page}>
      <PanelHeader
        title={
          <PanelHeaderLabel
            title="Decision Inbox"
            icon={<ListChecksIcon size="1rem" />}
          />
        }
      />
      <div className={styles.scroll}>
        <div className={styles.content}>
          <p className="text-body-sm text-subtle">
            Saved on this device for this account and community. Capture a
            source message from its menu.
          </p>
          {!writable && (
            <p role="status" className="text-body-sm text-subtle">
              Saved decisions are read-only until you reconnect.
            </p>
          )}
          {error && (
            <p role="alert" className={styles.notice}>
              {error}
            </p>
          )}
          {list.status === "damaged" ? (
            <EmptyState
              icon={<ListChecksIcon />}
              title="Saved decisions cannot be read"
              description="The saved list is damaged. You can start a new list on this device."
              action={
                <Button
                  disabled={!writable}
                  onClick={() => savedRevision && setResetting(savedRevision)}
                >
                  Reset saved list
                </Button>
              }
            />
          ) : list.status === "unavailable" ? (
            <EmptyState
              icon={<ListChecksIcon />}
              title="Device storage is unavailable"
              description="Check storage access, then reopen Decision Inbox."
            />
          ) : list.records.length === 0 ? (
            <EmptyState
              icon={<ListChecksIcon />}
              title="No decisions saved"
              description="Open a Buzz message's menu and choose Save to Decision Inbox."
            />
          ) : (
            groups.map(({ stage, title }) => {
              const records = list.records.filter(
                (item) => item.stage === stage,
              );
              return records.length ? (
                <section
                  key={stage}
                  className={styles.group}
                  aria-label={title}
                >
                  <InlineHeader title={`${title} · ${records.length}`} />
                  <ul className={styles.list}>
                    {records.map((item) => (
                      <li className={styles.row} key={sourceKey(item)}>
                        <div className={styles.details}>
                          <strong className="text-label text-primary">
                            {item.question}
                          </strong>
                          <p className="text-body-sm text-subtle">
                            {stage === "decision"
                              ? `Next: You decide · Then: ${item.nextActor}`
                              : stage === "handoff"
                                ? `Next: Hand off to ${item.nextActor}`
                                : `Handed off to ${item.nextActor}`}
                          </p>
                          {item.decision && (
                            <p className="text-body-sm text-primary">
                              Decision: {item.decision}
                            </p>
                          )}
                          {item.preview && (
                            <p className="text-body-sm text-subtle">
                              Source: {item.preview}
                            </p>
                          )}
                        </div>
                        <div className={styles.actions}>
                          <Button size="sm" onClick={() => openSource(item)}>
                            Open source
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!writable}
                            onClick={() =>
                              setEditing({
                                record: item,
                                revision: savedRevision,
                              })
                            }
                          >
                            Update
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!writable}
                            onClick={() =>
                              setRemoving({
                                record: item,
                                revision: savedRevision,
                              })
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null;
            })
          )}
        </div>
      </div>
      {editing && (
        <DecisionDialog
          key={sourceKey(editing.record)}
          scope={partition}
          record={editing.record}
          expectedRevision={editing.revision}
          current={current}
          close={() => setEditing(undefined)}
        />
      )}
      {removing && (
        <Dialog
          open
          size="compact"
          title="Remove saved decision?"
          description="This removes the decision from this device. The source message stays in Buzz."
          onOpenChange={(open) => !open && setRemoving(undefined)}
          actions={
            <>
              <Button onClick={() => setRemoving(undefined)}>Cancel</Button>
              <Button variant="destructive" onClick={confirmRemove}>
                Remove decision
              </Button>
            </>
          }
        >
          <p className="text-body">{removing.record.question}</p>
        </Dialog>
      )}
      {resetting !== undefined && (
        <Dialog
          open
          size="compact"
          title="Reset saved decisions?"
          description="This removes the damaged list from this device. It cannot be restored here."
          onOpenChange={(open) => !open && setResetting(undefined)}
          actions={
            <>
              <Button onClick={() => setResetting(undefined)}>Cancel</Button>
              <Button variant="prominent" onClick={confirmReset}>
                Reset list
              </Button>
            </>
          }
        >
          <p className="text-body">
            Only decisions for this account and community are affected.
          </p>
        </Dialog>
      )}
    </div>
  );
}
