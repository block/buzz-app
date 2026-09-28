import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import type { HistoryRow } from "../../features/agents/activity-history";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { ActivityDisclosure } from "./ActivityDisclosure";
import { ActivityStream } from "./ActivityStream";
import { activityRecords } from "../../features/agents/activity-records";
import { responseActivity } from "./response-activity";
const emptySubscribe = () => () => {};
const zero = () => 0;
/** User-requested historical pages, never capture demand or live lifecycle. */
export function SavedActivity({
  session,
  agent,
  channelId,
  messageId,
  expandHumanRequests = false,
}: {
  session: RelaySession;
  agent: string;
  channelId: string;
  messageId?: string;
  expandHumanRequests?: boolean;
}) {
  const history = session.activityHistory;
  const generation = useSyncExternalStore(
    history?.subscribe ?? emptySubscribe,
    history?.snapshot ?? zero,
  );
  return (
    <HistoryView
      key={`${generation}:${agent}:${channelId}:${messageId ?? ""}`}
      session={session}
      agent={agent}
      channelId={channelId}
      expandHumanRequests={expandHumanRequests}
      {...(messageId ? { messageId } : {})}
    />
  );
}
function HistoryView({
  session,
  agent,
  channelId,
  messageId,
  expandHumanRequests = false,
}: {
  session: RelaySession;
  agent: string;
  channelId: string;
  messageId?: string;
  expandHumanRequests?: boolean;
}) {
  const history = session.activityHistory;
  const archiveEpoch = useRef<string | undefined>(undefined);
  const [open, setOpen] = useState(false),
    [attempt, retry] = useState(0),
    [before, setBefore] = useState<number>(),
    [rows, setRows] = useState<readonly HistoryRow[]>([]),
    [more, setMore] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [deleteError, setDeleteError] = useState(""),
    [trimmed, setTrimmed] = useState(false),
    [confirm, setConfirm] = useState(false),
    [deleting, setDeleting] = useState(false);
  useEffect(() => {
    void attempt;
    if (!open || !history?.available) return;
    const controller = new AbortController();
    let live = true;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        let cursor = messageId ? undefined : before;
        const records: HistoryRow[] = [];
        let limited = false;
        for (
          let pageNumber = 0;
          pageNumber < (messageId ? 5 : 1);
          pageNumber++
        ) {
          const page = await history.read(
            agent,
            channelId,
            cursor,
            controller.signal,
          );
          if (
            archiveEpoch.current !== undefined &&
            archiveEpoch.current !== `${page.epoch}:${page.revision}`
          )
            throw new Error(
              "Saved Activity changed while paging. Close and reopen this view.",
            );
          archiveEpoch.current = `${page.epoch}:${page.revision}`;
          records.push(...page.records);
          limited ||= page.trimmed;
          if (!page.more) {
            cursor = undefined;
            break;
          }
          if (page.before === null)
            throw new Error("Saved Activity page boundary unavailable");
          cursor = page.before;
        }
        if (!live) return;
        if (messageId && (cursor !== undefined || limited))
          throw new Error(
            "Activity unavailable for this response: saved evidence is incomplete or trimmed.",
          );
        setRows((previous) => {
          const next =
            messageId || before === undefined
              ? records
              : [...previous, ...records];
          return next.slice(0, 500);
        });
        setMore(cursor !== undefined);
        setNext(cursor);
        setTrimmed(limited);
      } catch (reason) {
        if (live)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not read saved Activity.",
          );
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [open, attempt, before, history, agent, channelId, messageId]);
  const [next, setNext] = useState<number>();
  if (!history?.available) return null;
  const sorted = [...rows].reverse();
  const response = messageId
    ? responseActivity(sorted, agent, channelId, messageId)
    : undefined;
  const selected =
    response?.status === "available"
      ? response.records
      : messageId
        ? []
        : activityRecords(sorted, agent, channelId);
  async function remove() {
    setDeleting(true);
    setDeleteError("");
    try {
      await history.delete();
      setConfirm(false);
    } catch (reason) {
      setDeleteError(
        reason instanceof Error
          ? reason.message
          : "Could not delete saved Activity.",
      );
    } finally {
      setDeleting(false);
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ActivityDisclosure
        label={
          messageId ? "Saved activity for this response" : "Saved Activity"
        }
        expanded={open}
        onExpand={(value) => {
          if (value) {
            archiveEpoch.current = undefined;
            setRows([]);
            setBefore(undefined);
            setNext(undefined);
            setMore(false);
            setTrimmed(false);
            setError("");
          }
          setOpen(value);
        }}
      >
        <div className="flex min-w-0 flex-col gap-3">
          <p className="text-caption text-subtle">
            Historical capture only. Up to 30 days, 20,000 envelopes or 128 MiB
            of encrypted payload across this app; physical capacity may stop
            saving earlier. Gaps are possible while disabled or disconnected.
          </p>
          {loading && <p role="status">Loading saved Activity…</p>}
          {error && (
            <div role="alert">
              <p>{error}</p>
              <Button size="sm" onClick={() => retry((v) => v + 1)}>
                Retry saved Activity
              </Button>
            </div>
          )}
          {trimmed && !messageId && (
            <p className="text-body-sm text-subtle">
              Older evidence was removed by retention or access changes.
            </p>
          )}
          {!loading && !error && !selected.length && (
            <p>
              {messageId
                ? "Activity unavailable for this response. Its retained send interval is missing or ambiguous."
                : "No saved Activity in this scope."}
            </p>
          )}
          {!error && !!selected.length && (
            <ActivityStream
              session={session}
              records={selected}
              turns={[]}
              showDiagnostics
              showTurnHeading={false}
              expandHumanRequests={expandHumanRequests}
            />
          )}
          {more && !messageId && rows.length < 500 && (
            <Button disabled={loading} onClick={() => setBefore(next)}>
              Load earlier saved Activity
            </Button>
          )}
          {more && rows.length >= 500 && (
            <p role="status">
              Showing the latest 500 retained envelopes in this view.
            </p>
          )}
          {!messageId && (
            <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
              Delete saved Activity
            </Button>
          )}
        </div>
      </ActivityDisclosure>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        preventClose={deleting}
        title="Delete saved Activity?"
      >
        <p>
          This deletes all saved Activity for your current account in this
          community, not just this agent. It does not delete messages or old
          Buzz's archive. New Activity can be saved afterward.
        </p>
        <p>
          Replay protection may withhold new saved frames for up to five minutes
          after deletion. Live Activity continues; this is not secure erasure of
          backups.
        </p>
        {deleteError && <p role="alert">{deleteError}</p>}
        <Button disabled={deleting} onClick={() => void remove()}>
          Delete saved Activity for this community
        </Button>
      </Dialog>
    </div>
  );
}
