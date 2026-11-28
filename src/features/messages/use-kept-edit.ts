import {
  useCallback,
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
} from "react";
import { readView, writeView } from "../../shared/view-state";
import type { ChannelMessage } from "../relay/contracts";
import { mentionDraft, type MentionDraft } from "./mention-draft";

/** An unsaved message edit, kept under its view's edit: key beside the
 * new-message draft, never in it, so Drafts does not list it. `base` is the
 * message text the edit opened from; `resume` is whether it reopens unasked. */
export type KeptEdit = {
  id: string;
  base: string;
  draft: MentionDraft;
  resume: boolean;
};

/** What choosing Edit opens. `row`, resuming `kept` when its rewrite is kept;
 * `redirected` when that rewrite opens in place of the message chosen.
 * `discard`: the kept rewrite of that message cannot open here, and Edit
 * chosen again while that is said, naming it, discards it. undefined: nothing,
 * as another composer here keeps a different edit open on this key, or a quiet
 * start has no kept edit of its own to resume. */
export type EditOpening =
  | { row: ChannelMessage; kept: KeptEdit | undefined; redirected: boolean }
  | { discard: string }
  | undefined;

// The edit each composer in this window has open, so a quiet resume leaves it
// alone and choosing Edit elsewhere takes it over. handOver() is false while
// the kept record lacks its text.
const openEdits = new Map<
  object,
  { view: string; id: string; handOver(): boolean }
>();
const noSubscription = () => () => {};

/** Owns a composer's kept edit: its record, the composer that has it open in
 * this window, reopening it after a remount, and a record that could not be
 * written. The composer owns the editor. */
export function useKeptEdit({
  scope,
  key,
  resume,
  find,
  subscribe,
  ready,
  blocked,
  reopen,
  close,
}: {
  scope: string;
  /** The edit: key; undefined keeps nothing. */
  key: string | undefined;
  /** Whether an edit kept from an earlier mount reopens unasked. */
  resume: boolean;
  /** The row a waiting edit reopens from: undefined while it may still load,
   * "missing" once the rows have loaded without it. */
  find(id: string): ChannelMessage | "missing" | undefined;
  /** Reports changes to what `find` reads; subscribed only while waiting. */
  subscribe(listener: () => void): () => void;
  /** Whether a waiting edit may reopen now. */
  ready: boolean;
  /** The composer reports an error for its draft, which ends the wait. */
  blocked: boolean;
  /** Opens `row` quietly; false while the composer cannot edit. */
  reopen(row: ChannelMessage): boolean;
  /** Closes the editor without moving focus, as another composer takes its
   * edit over. */
  close(): void;
}) {
  const [self] = useState(() => ({}));
  const view = `${scope}\n${key}`;
  const [storageFailed, setStorageFailed] = useState(false);
  const record = () =>
    key ? readView<Record<string, unknown> | null>(scope, key, null) : null;
  const read = (): KeptEdit | undefined => {
    const kept = record();
    return typeof kept?.id === "string" && typeof kept.base === "string"
      ? {
          id: kept.id,
          base: kept.base,
          draft: mentionDraft(kept.draft),
          resume: kept.resume !== false,
        }
      : undefined;
  };
  const clear = () => {
    if (key) writeView(scope, key, null);
  };
  /** Whether the kept edit reopens unasked. A new-message draft written while
   * it is closed stops that until Edit is chosen. */
  const mark = (resume: boolean) => {
    const kept = record();
    if (key && kept && (kept.resume !== false) !== resume)
      writeView(scope, key, { ...kept, resume });
  };
  const openHere = () =>
    [...openEdits.values()].find((edit) => edit.view === view);
  // Another composer took this edit over: return to the draft without moving
  // focus here. Text that could not be kept stays here.
  const handOver = useEffectEvent(() => {
    if (storageFailed) return false;
    openEdits.delete(self);
    close();
    return true;
  });
  // An edit kept from an earlier mount reopens once its message loads, unless
  // another composer in this window has it open. Refreshed rows that load
  // without it, a change to the new-message draft, or an error the composer
  // reports for it, as for a recovered send, end the wait. A draft change also
  // keeps a later mount from waiting (see mark).
  // It starts in a later commit than the mount: StrictMode's replayed mount
  // effects rebuild the editor from the draft and would drop its reset.
  const [waiting, setWaiting] = useState<string>();
  const wait = useEffectEvent(() => {
    const kept = read();
    if (resume && kept?.resume) setWaiting(kept.id);
  });
  useEffect(() => wait(), []);
  useEffect(() => () => void openEdits.delete(self), [self]);
  const subscribeWaiting = useCallback(
    (listener: () => void) =>
      waiting ? subscribe(listener) : noSubscription(),
    [waiting, subscribe],
  );
  const waited = useSyncExternalStore(subscribeWaiting, () =>
    waiting ? find(waiting) : undefined,
  );
  const reopenWaited = useEffectEvent((row: ChannelMessage) => reopen(row));
  useEffect(() => {
    if (!waited) return;
    if (waited === "missing" || blocked) setWaiting(undefined);
    else if (ready && reopenWaited(waited)) setWaiting(undefined);
  }, [waited, blocked, ready]);
  return {
    /** The open edit's latest text could not be kept on this device. */
    storageFailed,
    /** Claims the edit of `row`, editable and with no edit open in this
     * composer: takes it over from another composer that has it open, or
     * opens a kept rewrite of another message in its place. A quiet start
     * only resumes this message's kept edit. `discard` names the message
     * whose kept rewrite this composer says Edit would discard. */
    open(
      row: ChannelMessage,
      editableRow: (id: string) => ChannelMessage | undefined,
      quiet: boolean,
      discard: string | undefined,
    ): EditOpening {
      const other = openHere();
      // The kept record holds the latest text of the edit taken over.
      if (other && (quiet || other.id !== row.id || !other.handOver())) return;
      const kept = read();
      // A quiet start only resumes this message's kept edit, which may have
      // ended, been replaced or been kept closed while it waited.
      if (quiet && (kept?.id !== row.id || !kept.resume)) return;
      // A kept rewrite of another message opens in its place. One whose
      // message is not here to open, perhaps deleted, is discarded only when
      // Edit is chosen again while that is said.
      const earlier = !!kept && kept.id !== row.id;
      if (kept && earlier) {
        const keptRow = editableRow(kept.id);
        if (keptRow) row = keptRow;
        else if (discard !== kept.id) return { discard: kept.id };
        else clear();
      }
      const resumed = kept?.id === row.id ? kept : undefined;
      // Chosen again, it reopens on return as an edit left open does.
      if (resumed) mark(true);
      openEdits.set(self, { view, id: row.id, handOver });
      return { row, kept: resumed, redirected: !!resumed && earlier };
    },
    /** Keeps the open edit's text for a remount or another composer. A record
     * that cannot be updated is cleared, so neither takes its older text for
     * the latest; the text then stays only in this editor. */
    keep(id: string, base: string | undefined, draft: MentionDraft) {
      if (!key) return;
      const kept = writeView(scope, key, { id, base, draft });
      if (!kept) writeView(scope, key, null);
      setStorageFailed(!kept);
    },
    /** The editor closed. An edit handed over to another composer keeps its
     * record there. */
    closed() {
      if (openEdits.delete(self)) clear();
      setStorageFailed(false);
    },
    /** The outbox owns the edit, a failed one included. */
    saved() {
      clear();
      setStorageFailed(false);
    },
    /** A new-message draft was written. A draft in use is not replaced by a
     * kept edit until Edit is chosen, in this mount or a later one. One open
     * in another composer, as the thread under a review, still reopens by
     * itself. */
    drafted() {
      setWaiting(undefined);
      if (!openHere()) mark(false);
    },
  };
}
