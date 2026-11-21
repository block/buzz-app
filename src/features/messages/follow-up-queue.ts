import type { RelaySession } from "../relay/session";
import type { OutboxRecovery, OutgoingEvent } from "../relay/outbox";
import { followUpMessage } from "./follow-up-message";
import {
  followUpStorage,
  followUpRecovery,
  followUpTargets,
  type FollowUpMessage,
  type FollowUpHandoff,
  type FollowUpPauseState,
} from "./follow-up-storage";

type Activity = ReturnType<RelaySession["agentActivity"]["snapshot"]>;
type Wait = { agent: string; message?: string; turn?: string; resumed?: true };
type Entry = {
  id: string;
  createdAt?: number;
  channelId: string;
  text: string;
  recipients: readonly string[];
  publish(recovery?: OutboxRecovery): string;
  message?: FollowUpMessage;
  restored?: boolean;
  recovered?: true;
  admitted?: boolean;
  resumedBy?: Set<string>;
  deliveryId?: string | undefined;
  dismissedDelivery?: string | undefined;
  resumeCancelled?: boolean;
  predecessorRemoved?: boolean;
  sending?: boolean;
  ready?(): boolean;
  beforeRelease?(): Promise<void>;
  beforePublish?(): void;
  onSend?(id: string): void;
  error?: string;
};
const queues = new WeakMap<RelaySession, ReturnType<typeof createQueue>>();
/** An owner's Stop paused this chat's queue. */
export type FollowUpPause = Readonly<{
  /** Saving the pause failed; only this window keeps it. */
  saveError?: string;
  /** A message passed its final check before Stop and was sent. */
  sentBeforeStop?: true;
}>;
/** What this window still has to say about a chat's queue after a pause. */
export type FollowUpNotice = Readonly<{
  /** A message went out after Stop, and no queued rows are left to pause. */
  sentBeforeStop?: true;
  /** This window resumed the queue but couldn't save that. */
  resumeUnsaved?: true;
}>;
const DM_QUEUE_LIMIT = 20;

/** Pending Solo sends survive navigation and, with a message payload, restart. */
export function followUpQueue(session: RelaySession) {
  let queue = queues.get(session);
  if (!queue) {
    queue = createQueue(session);
    queues.set(session, queue);
  }
  return queue;
}

// After a restart, a former window's exit proves nothing about delivery.
const UNRESOLVED_HANDOFF =
  "An earlier queued message may not have finished sending. Check the conversation, then Send when ready.";

type HandoffMark = { id: string; message: string | undefined };

function createQueue(session: RelaySession) {
  let entries: readonly Entry[] = [];
  const storage =
    session.scope && session.viewer
      ? followUpStorage(session.scope)
      : undefined;
  let storageError: string | undefined;
  let sequence = Date.now();
  const waits = new Map<string, Wait[]>();
  const edits = new Set<string>();
  // Persist completion of our handoffs so other windows can recognize it.
  const handoffs = new Map<string, FollowUpHandoff>();
  const settlingHandoffs = new Set<string>();
  const refreshingSending = new Set<string>();
  // Stop pauses a chat at once, in memory; the saved pause record carries it
  // to other windows and restarts. `saved` is whether storage matched at
  // last write. Every change to the record is saved under the chat lock and
  // takes its next `seq`, so the lock orders Stop, Resume, Send now, enqueue
  // and the queue emptying.
  const pauses = new Map<string, FollowUpPause & { saved?: boolean }>();
  let pauseView: ReadonlyMap<string, FollowUpPause> = new Map();
  // A Resume this window hasn't saved yet, or couldn't save. It overrides
  // only the saved Stop it saw: a newer Stop, or the queue emptying, ends it.
  const resumes = new Map<
    string,
    { lastStopSeq: number; generation: number; failed?: true }
  >();
  const overrides = (
    resume: { lastStopSeq: number; generation: number },
    state: FollowUpPauseState,
  ) =>
    resume.lastStopSeq === state.lastStopSeq &&
    resume.generation === state.generation;
  // Send now: the saved `seq` and `generation` it was clicked under. A Stop
  // saved after that cancels it.
  const approvals = new Map<string, { seq: number; generation: number }>();
  const clearing = new Set<string>();
  // Rows whose durable save waits for the chat lock. They show at once but
  // cannot release until the save lands.
  const admitting = new Set<string>();
  // Chats whose pause ended with no rows left after a message went out
  // past Stop: the note outlives the pause until the next message or Stop.
  const stopNotices = new Set<string>();
  let noticeKey = "";
  let noticeView: ReadonlyMap<string, FollowUpNotice> = new Map();
  function notices() {
    const failed = [...resumes]
      .filter(([, resume]) => resume.failed)
      .map(([channelId]) => channelId);
    const key = JSON.stringify([[...stopNotices].sort(), failed.sort()]);
    if (key === noticeKey) return noticeView;
    noticeKey = key;
    const view = new Map<string, FollowUpNotice>();
    for (const channelId of stopNotices)
      view.set(channelId, { sentBeforeStop: true });
    for (const channelId of failed)
      view.set(channelId, { ...view.get(channelId), resumeUnsaved: true });
    noticeView = view;
    return noticeView;
  }
  const pausesChanged = () => {
    pauseView = new Map(
      [...pauses].map(([channelId, { saved: _, ...pause }]) => [
        channelId,
        pause,
      ]),
    );
  };
  /**
   * Whether the saved record pauses this chat for this window. A Resume of
   * this window's that the record no longer matches is dropped here.
   */
  function savedPaused(channelId: string) {
    if (!storage) return false;
    const state = storage.pauseState(channelId);
    const resume = resumes.get(channelId);
    if (resume && (!state.paused || !overrides(resume, state)))
      resumes.delete(channelId);
    return state.paused && !resumes.has(channelId);
  }
  function restorePauses() {
    if (!storage) return;
    let changed = false;
    for (const channelId of new Set(entries.map((entry) => entry.channelId))) {
      let saved: boolean;
      try {
        saved = savedPaused(channelId);
      } catch {
        // An unreadable pause fails only this chat's releases.
        continue;
      }
      const current = pauses.get(channelId);
      if (saved && !current) {
        pauses.set(channelId, { saved: true });
        changed = true;
      } else if (!saved && current?.saved) {
        // Another window resumed this chat after our pause was saved.
        pauses.delete(channelId);
        changed = true;
      }
    }
    if (changed) pausesChanged();
  }
  function restore() {
    if (!storage) return;
    try {
      const saved = storage.load();
      sequence = Math.max(sequence, ...saved.map((entry) => entry.createdAt));
      // A row still waiting for its save is neither removed nor restored.
      const pending = entries.filter(
        (entry) =>
          admitting.has(entry.id) && !saved.some((row) => row.id === entry.id),
      );
      const removed = entries.filter(
        (entry) =>
          !admitting.has(entry.id) && !saved.some((row) => row.id === entry.id),
      );
      const predecessors = new Map(
        saved.map((row) => [
          row.id,
          removed.filter(
            (entry) =>
              entry.channelId === row.channelId &&
              entry.createdAt !== undefined &&
              (row.createdAt > entry.createdAt ||
                (row.createdAt === entry.createdAt &&
                  row.id.localeCompare(entry.id) > 0)),
          ),
        ]),
      );
      entries = saved.map((saved) => {
        const existing = entries.find((entry) => entry.id === saved.id);
        if (existing) {
          // Keep the message object captured by the original publish guards.
          existing.text = saved.text;
          if (existing.message) existing.message.text = saved.text;
          return existing;
        }
        return {
          ...saved,
          recipients: followUpTargets(saved, session.viewer),
          message: saved,
          restored: true,
          recovered: true,
          ...followUpMessage(session, saved),
        };
      });
      if (pending.length)
        entries = [...entries, ...pending].sort(
          (a, b) =>
            (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id),
        );
      for (const entry of entries) {
        if (admitting.has(entry.id)) continue;
        const removed = predecessors.get(entry.id) ?? [];
        const predecessor = removed.length
          ? storage.handoff(entry.channelId)
          : null;
        if (
          removed.some(
            (entry) =>
              predecessor?.id !== entry.id ||
              !(predecessor.complete || handoffFinished(predecessor)),
          )
        ) {
          entry.restored = true;
          entry.resumeCancelled = true;
          entry.predecessorRemoved = true;
        }
        // A saved hold outlives this window: only the row's own Send clears it.
        if (held(entry.id)) showHold(entry);
        if (!entry.error)
          entry.sending =
            !entry.dismissedDelivery &&
            (!!entry.deliveryId ||
              saved.find((row) => row.id === entry.id)?.sending === true);
      }
      restorePauses();
      storageError = undefined;
      refreshSending();
    } catch (error) {
      storageError = error instanceof Error ? error.message : String(error);
    }
  }
  restore();
  // A resumed request supersedes its old observer turn, which may never emit
  // completion after the old process died. Only fresh local work settles it.
  const resumedRequests = new Set<string>();
  const resumedTurn = (turn: Activity["turns"][number]) =>
    !!turn.requests?.length &&
    turn.requests.every((request) =>
      resumedRequests.has(`${turn.agent}:${request.messageId}`),
    );
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;
  // Other windows' writes reach this queue while it shows rows or still has
  // work to watch, whether or not a composer is mounted.
  let observingStorage = false;
  function observeStorage() {
    const wanted =
      !!storage &&
      typeof window !== "undefined" &&
      (listeners.size > 0 || !!stop);
    if (wanted === observingStorage) return;
    observingStorage = wanted;
    if (wanted) window.addEventListener("storage", onStorage);
    else window.removeEventListener("storage", onStorage);
  }
  const publishing = new Set<string>();
  // Rows checking their recipients before they take the chat lock.
  const releasing = new Set<string>();
  // Rows whose old delivery evidence is gone: they leave the locks and
  // check their recipients again before taking them back.
  const revalidating = new Set<string>();
  const requested = new Map<string, (() => void) | undefined>();
  const acknowledging = new Set<string>();
  let activating = false;
  const emit = () => {
    for (const listener of listeners) listener();
  };
  function finished(wait: Wait, activity: Activity) {
    if (wait.message) {
      const local = activity.local?.find(
        (row) => row.agent === wait.agent && row.messageId === wait.message,
      );
      if (local)
        return (
          local.state === "done" ||
          local.state === "error" ||
          local.state === "superseded" ||
          local.state === "stopped"
        );
      if (wait.resumed) return false;
      const turns = activity.turns.filter(
        (turn) =>
          turn.agent === wait.agent &&
          turn.requests?.some((request) => request.messageId === wait.message),
      );
      return turns.length > 0 && turns.every((turn) => turn.state === "ended");
    }
    return activity.turns.some(
      (turn) =>
        turn.agent === wait.agent &&
        turn.turnId === wait.turn &&
        (turn.state === "ended" || resumedTurn(turn)),
    );
  }
  function blockers(channelId: string) {
    const activity = session.agentActivity?.snapshot();
    let current = waits.get(channelId) ?? [];
    if (activity) {
      current = current.filter((wait) => !finished(wait, activity));
      const local = (activity.local ?? []).filter(
        (row) => row.channelId === channelId,
      );
      for (const row of local) {
        if (row.state === "working" || row.state === "waiting")
          current.push({ agent: row.agent, message: row.messageId });
      }
      for (const turn of activity.turns) {
        if (
          turn.channelId === channelId &&
          turn.state === "working" &&
          !resumedTurn(turn)
        )
          current.push({ agent: turn.agent, turn: turn.turnId });
      }
    }
    current = [
      ...new Map(current.map((wait) => [JSON.stringify(wait), wait])).values(),
    ];
    if (current.length) waits.set(channelId, current);
    else waits.delete(channelId);
    return (
      current.length > 0 ||
      (session.typing?.snapshot() ?? []).some(
        (entry) =>
          entry.channelId === channelId &&
          !entry.threadRootId &&
          session.agentChoices
            ?.snapshot()
            .identities.some((agent) => agent.pubkey === entry.pubkey),
      ) ||
      (activity?.typing ?? []).some(
        (entry) => entry.channelId === channelId && !entry.threadRootId,
      ) ||
      (!!activity &&
        activity.status !== "listening" &&
        activity.status !== "unavailable")
    );
  }
  // Called only while owning the saved row (or for an in-memory-only row).
  async function clearDismissed(entry: Entry) {
    const dismissed = entry.dismissedDelivery;
    if (
      !dismissed ||
      !entries.includes(entry) ||
      entry.deliveryId !== dismissed
    )
      return false;
    if (storage && entry.message && storage.has(entry.id)) {
      const handoff = storage.handoff(entry.channelId);
      const receipt = await session.outbox?.recovery(
        followUpRecovery(entry.id).key,
      );
      if (
        (handoff?.id === entry.id &&
          handoff.message &&
          handoff.message !== dismissed) ||
        receipt
      ) {
        entry.dismissedDelivery = undefined;
        entry.deliveryId = receipt?.event.id ?? entry.deliveryId;
        entry.sending = true;
        entries = [...entries];
        emit();
        return false;
      }
      storage.sending(entry.id, false);
    }
    const remaining = (waits.get(entry.channelId) ?? []).filter(
      (wait) => wait.message !== dismissed,
    );
    if (remaining.length) waits.set(entry.channelId, remaining);
    else waits.delete(entry.channelId);
    entry.deliveryId = undefined;
    entry.dismissedDelivery = undefined;
    entry.sending = false;
    entries = [...entries];
    emit();
    return true;
  }
  function watch() {
    if (stop) return;
    activating = true;
    const unsubscribe = session.agentActivity.subscribe(pump);
    const deactivate = session.agentActivity.activate();
    const offTyping = session.typing?.subscribe(pump);
    const offChoices = session.agentChoices?.subscribe(pump);
    const offChannels = session.channels.subscribeList?.(() => {
      const roster = session.channels.list();
      // The store retains channels on ordinary loading/read failures. Confirmed
      // denial removes them even when list status is error; cached membership
      // alone does not establish revocation.
      for (const entry of entries)
        if (roster.channels.some((row) => row.id === entry.channelId))
          entry.admitted = true;
      const retired = new Set(
        [
          ...waits.keys(),
          ...handoffs.keys(),
          ...entries.map((entry) => entry.channelId),
        ].filter((id) => {
          const channel = roster.channels.find((row) => row.id === id);
          return (
            (!channel &&
              (roster.status === "ready" ||
                entries.some(
                  (entry) => entry.channelId === id && entry.admitted,
                ))) ||
            (channel?.readOnly && !channel.cached)
          );
        }),
      );
      if (!retired.size) return;
      for (const entry of entries.filter((entry) =>
        retired.has(entry.channelId),
      ))
        remove(entry.id);
      for (const id of retired) {
        waits.delete(id);
        handoffs.delete(id);
      }
      emit();
      pump();
    });
    const offDismiss = session.outbox?.observeDismiss((item) => {
      if (item.delivery !== "failed") return;
      for (const handoff of handoffs.values())
        if (handoff.message === item.event.id) handoff.complete = true;
      for (const entry of entries) {
        if (entry.deliveryId !== item.event.id) continue;
        entry.dismissedDelivery = item.event.id;
        const clear = () => clearDismissed(entry);
        if (storage && entry.message)
          void storage
            .lockChat(entry.channelId, () => storage.lock(entry.id, clear))
            .catch((error) => {
              // Keep dismissal evidence so Send can retry this save under its
              // lock. The delivery itself is already durably dismissed.
              entry.sending = false;
              entry.error =
                error instanceof Error ? error.message : String(error);
              entries = [...entries];
              emit();
            });
        else void clear();
      }
      entries = [...entries];
      emit();
      for (const [channelId, current] of waits) {
        const remaining = current.filter(
          (wait) => wait.message !== item.event.id,
        );
        if (remaining.length) waits.set(channelId, remaining);
        else waits.delete(channelId);
      }
      pump();
    });
    const offRemoval = session.channelLifecycle?.observeRemoval((channelId) => {
      for (const entry of entries.filter(
        (entry) => entry.channelId === channelId,
      ))
        remove(entry.id);
      waits.delete(channelId);
      handoffs.delete(channelId);
      emit();
      pump();
    });
    const offOutbox = session.outbox?.subscribe(() => {
      reconcileDelivery();
    });
    stop = () => {
      offOutbox?.();
      unsubscribe();
      offTyping?.();
      offChoices?.();
      offChannels?.();
      offDismiss?.();
      offRemoval?.();
      deactivate();
    };
    observeStorage();
    activating = false;
  }
  function waitForMessage(
    entry: Pick<Entry, "channelId" | "recipients">,
    id: string,
  ) {
    // Include the gap between publication and the first working signal.
    waits.set(entry.channelId, [
      ...(waits.get(entry.channelId) ?? []),
      ...entry.recipients.map((agent) => ({ agent, message: id })),
    ]);
    watch();
  }
  function sent(entry: Omit<Entry, "id">, recovery?: OutboxRecovery) {
    const id = entry.publish(recovery);
    waitForMessage(entry, id);
    return id;
  }
  // A sent follow-up keeps its recovery after its queue record is removed. With
  // the record gone, nothing here can resend it, so its send may be discarded.
  function orphaned(item: OutgoingEvent | undefined) {
    const recovery = item?.recovery;
    if (
      !storage ||
      !recovery ||
      recovery.key !== followUpRecovery(recovery.value).key
    )
      return false;
    try {
      return !storage.has(recovery.value);
    } catch {
      return false;
    }
  }
  // Recovery metadata bridges the durable queue to the durable Outbox. Keep it
  // until the queue record is removed, then release accepted delivery receipts.
  function reconcileDelivery() {
    if (!storage || !session.outbox) return;
    try {
      for (const item of session.outbox.snapshot()) {
        if (
          !item.recovery?.key.startsWith("follow-up:") ||
          item.acknowledged ||
          (item.delivery !== "accepted" && item.delivery !== "seen") ||
          storage.has(item.recovery.value) ||
          acknowledging.has(item.event.id)
        )
          continue;
        acknowledging.add(item.event.id);
        void session.outbox
          .acknowledge(item.event.id)
          .catch(() => {})
          .finally(() => {
            acknowledging.delete(item.event.id);
            pump();
          });
      }
    } catch (error) {
      storageError = error instanceof Error ? error.message : String(error);
      emit();
    }
  }
  /** A row with delivery evidence recovers it first, under the locks. */
  function deliveryEvidence(entry: Entry) {
    if (entry.deliveryId || entry.dismissedDelivery || entry.sending)
      return true;
    try {
      return !!storage && !!entry.message && storage.isSending(entry.id);
    } catch {
      return true;
    }
  }
  async function release(
    entry: Entry,
    locked = false,
    validated = false,
  ): Promise<void> {
    if (!locked && !validated) {
      if (
        !entries.includes(entry) ||
        admitting.has(entry.id) ||
        releasing.has(entry.id) ||
        publishing.has(entry.id) ||
        edits.has(entry.id)
      )
        return;
      // Check recipients before taking the chat lock, so the lock covers
      // only the final checks and the Outbox handoff. A Stop saved while
      // this runs is read under the lock and holds the row.
      if (entry.beforeRelease && !deliveryEvidence(entry)) {
        releasing.add(entry.id);
        try {
          await entry.beforeRelease();
        } catch (error) {
          entries = entries.map((item) =>
            item === entry
              ? {
                  ...item,
                  error: error instanceof Error ? error.message : String(error),
                }
              : item,
          );
          requested.delete(entry.id);
          approvals.delete(entry.id);
          emit();
          queueMicrotask(pump);
          return;
        } finally {
          releasing.delete(entry.id);
        }
        validated = true;
      }
    }
    if (storage && entry.message && !locked) {
      try {
        await storage.lockChat(entry.channelId, () =>
          storage.lock(entry.id, () => release(entry, true, validated)),
        );
      } catch (error) {
        revalidating.delete(entry.id);
        entries = entries.map((item) =>
          item === entry
            ? {
                ...item,
                error: error instanceof Error ? error.message : String(error),
              }
            : item,
        );
        emit();
        return;
      }
      // Recovery found no event to resume: check recipients again outside
      // the locks, then take them back for the final checks.
      if (revalidating.delete(entry.id)) await release(entry);
      return;
    }
    if (locked && storage && entry.message) {
      const saved = storage.load().find((row) => row.id === entry.id);
      if (saved) {
        entry.text = saved.text;
        entry.message.text = saved.text;
      }
      // A Stop saved after this Send now's click cancels it, even when a
      // Resume followed. The row goes back to its place in the queue.
      if (requested.has(entry.id) && !approved(entry)) {
        requested.delete(entry.id);
        approvals.delete(entry.id);
        emit();
      }
    }
    if (
      !entries.includes(entry) ||
      publishing.has(entry.id) ||
      edits.has(entry.id)
    )
      return;
    publishing.add(entry.id);
    let id: string | undefined;
    let awaitingChoices = false;
    let claimed = false;
    try {
      if (entry.dismissedDelivery && !(await clearDismissed(entry))) return;
      if (storage && entry.message) {
        if (!storage.has(entry.id)) {
          restore();
          return;
        }
        if (!session.outbox)
          throw new Error("Message delivery is unavailable.");
        await session.outbox.ready();
        const previous = await session.outbox.recovery(
          followUpRecovery(entry.id).key,
        );
        if (!previous && entry.deliveryId) {
          entry.dismissedDelivery = entry.deliveryId;
          if (!(await clearDismissed(entry))) return;
        }
        if (previous) {
          entry.deliveryId = previous.event.id;
          if (
            !session.outbox
              .snapshot()
              .some((item) => item.event.id === previous.event.id)
          )
            throw new Error(
              "This message is owned by another window. Reload to recover its delivery.",
            );
          if (storage.handoff(entry.channelId)?.id === entry.id) {
            const handoff = {
              id: entry.id,
              message: previous.event.id,
              recipients: entry.recipients,
              owner: await storage.owner(),
            };
            storage.claim(entry.channelId, handoff);
            handoffs.set(entry.channelId, handoff);
          }
          await session.outbox.recover(
            previous.event.id,
            followUpRecovery(entry.id),
            () => {
              storage.remove(entry.id);
              waitForMessage(entry, previous.event.id);
            },
          );
          entries = entries.filter((item) => item !== entry);
          return;
        }
        if (storage.isSending(entry.id))
          throw new Error(
            "This message may already be sending in another window. Reload to recover its delivery. If it was interrupted before sending, check the conversation before removing this row and sending again.",
          );
      }
      // A row whose delivery evidence recovered no event checks its
      // recipients outside the locks, so a Stop can still land before the
      // final checks below.
      if (!validated && entry.beforeRelease) {
        if (deliveryEvidence(entry))
          throw new Error("Message delivery is unavailable. Try again.");
        revalidating.add(entry.id);
        return;
      }
      const owner =
        storage && entry.message ? await storage.owner() : undefined;
      const predecessor =
        storage && entry.message ? storage.handoff(entry.channelId) : null;
      // An earlier hand-off this window doesn't own, with no completion evidence.
      const replaces =
        !!storage &&
        !!predecessor &&
        !predecessor.complete &&
        !handoffFinished(predecessor) &&
        predecessor.id !== handoffs.get(entry.channelId)?.id;
      const unresolved =
        storage && predecessor && !requested.has(entry.id) && replaces;
      // A live owner may still be handing it off. After a restart, its former
      // window's exit proves nothing about delivery, so a row restored from
      // storage waits for completion evidence or its own Send.
      const heldBy = !unresolved
        ? undefined
        : (await storage.isLive(predecessor))
          ? "live"
          : entry.recovered
            ? "unresolved"
            : undefined;
      const livePredecessor = !!heldBy;
      // Ownership queries can yield to pauses, removals, and new activity.
      // Keep the final publication guards and claim in one synchronous step.
      if (!entries.includes(entry)) return;
      if (
        !requested.has(entry.id) &&
        (entry.restored ||
          isPaused(entry.channelId, true) ||
          blockers(entry.channelId))
      )
        return;
      if (storage && entry.message && !storage.has(entry.id)) return;
      if (!requested.has(entry.id) && entry.message && held(entry.id)) {
        showHold(entry);
        entries = [...entries];
        return;
      }
      if (entry.ready?.() === false) {
        awaitingChoices = true;
        return;
      }
      if (storage && entry.message) {
        const first = storage
          .load()
          .find((row) => row.channelId === entry.channelId);
        if (
          !requested.has(entry.id) &&
          (first?.id !== entry.id || livePredecessor)
        ) {
          entries = entries.map((item) =>
            item === entry
              ? {
                  ...item,
                  restored: true,
                  resumeCancelled: true,
                  error:
                    heldBy === "unresolved"
                      ? UNRESOLVED_HANDOFF
                      : "Another window may be handling an earlier queued message. Check the conversation, then Send when ready.",
                }
              : item,
          );
          return;
        }
      }
      entry.beforePublish?.();
      requested.get(entry.id)?.();
      if (storage && entry.message) {
        // Sending past an unresolved hand-off replaces its evidence; every
        // other row keeps waiting for its own Send.
        if (replaces) holdSuccessors(entry.channelId, entry.id);
        // Retain the claim after removing the row: storage events and agent
        // activity in another window may both arrive after this handoff.
        storage.claim(entry.channelId, {
          id: entry.id,
          recipients: entry.recipients,
          ...(owner ? { owner } : {}),
        });
        claimed = true;
        storage.sending(entry.id, true);
      }
      entry.sending = true;
      entries = [...entries];
      emit();
      try {
        id = sent(
          entry,
          entry.message ? followUpRecovery(entry.id) : undefined,
        );
        entry.deliveryId = id;
        if (storage && entry.message) {
          const handoff = {
            id: entry.id,
            message: id,
            recipients: entry.recipients,
            ...(owner ? { owner } : {}),
          };
          handoffs.set(entry.channelId, handoff);
          storage.claim(entry.channelId, handoff);
        }
      } catch (error) {
        if (storage && entry.message && !id) storage.sending(entry.id, false);
        throw error;
      }
      if (storage && entry.message) {
        if (!session.outbox)
          throw new Error("Message delivery is unavailable.");
        await session.outbox.recover(id, followUpRecovery(entry.id), () =>
          storage.remove(entry.id),
        );
      }
      entries = entries.filter((item) => item !== entry);
    } catch (error) {
      if (claimed && !id)
        handoffs.set(entry.channelId, {
          id: entry.id,
          recipients: entry.recipients,
          complete: true,
        });
      entries = entries.map((item) =>
        item === entry
          ? {
              ...item,
              sending: !!item.deliveryId && !item.dismissedDelivery,
              error: error instanceof Error ? error.message : String(error),
            }
          : item,
      );
    } finally {
      publishing.delete(entry.id);
      if (!awaitingChoices && !revalidating.has(entry.id)) {
        requested.delete(entry.id);
        approvals.delete(entry.id);
      }
      emit();
      reconcileDelivery();
      queueMicrotask(pump);
    }
    // Presentation failures cannot put an already accepted message back in queue.
    if (id) entry.onSend?.(id);
  }
  function handoffFinished(handoff: FollowUpHandoff) {
    const activity = session.agentActivity?.snapshot();
    const message = handoff.message;
    return (
      !!activity &&
      !!message &&
      handoff.recipients.every((agent) =>
        finished(
          {
            agent,
            message,
            ...(resumedRequests.has(`${agent}:${message}`)
              ? { resumed: true as const }
              : {}),
          },
          activity,
        ),
      )
    );
  }
  /**
   * In-memory first, then the saved record another window or a restart left.
   * `strict` (the final guard) fails the release when the record can't be read.
   */
  function isPaused(channelId: string, strict = false) {
    if (!entries.some((entry) => entry.channelId === channelId)) return false;
    if (pauses.has(channelId)) return true;
    try {
      if (!savedPaused(channelId)) return false;
    } catch (error) {
      if (strict) throw error;
      return false;
    }
    pauses.set(channelId, { saved: true });
    pausesChanged();
    emit();
    return true;
  }
  /** Under the chat lock: this Send now's click came after every saved Stop. */
  function approved(entry: Entry) {
    if (!storage) return true;
    const approval = approvals.get(entry.id);
    const state = storage.pauseState(entry.channelId);
    return (
      !!approval &&
      approval.generation === state.generation &&
      approval.seq >= state.lastStopSeq
    );
  }
  /**
   * Save this window's current pause intent under the chat lock, where it
   * takes the record's next `seq`; lock order decides between windows.
   * `handoffBefore` is the chat's handoff marker when Stop was pressed. A
   * release another window held the lock for has finished by then; a new
   * marker with a message means that row went out after Stop, and Stop says
   * so.
   */
  function savePause(
    channelId: string,
    stop?: { handoffBefore: HandoffMark | null | undefined },
  ) {
    if (!storage) return Promise.resolve();
    const resume = stop ? undefined : resumes.get(channelId);
    return storage
      .lockChat(channelId, async () => {
        const state = storage.pauseState(channelId);
        if (!stop) {
          // A Stop pressed here after this Resume replaced it.
          if (!resume || resumes.get(channelId) !== resume) return;
          if (state.paused && !overrides(resume, state)) {
            // A Stop saved after this Resume was clicked holds the lock order.
            resumes.delete(channelId);
            pauses.set(channelId, { saved: true });
            pausesChanged();
            emit();
            return;
          }
          storage.savePauseState(channelId, {
            ...state,
            seq: state.seq + 1,
            paused: false,
          });
          resumes.delete(channelId);
          emit();
          return;
        }
        // Every Stop saves its `seq`, which cancels every Send now clicked
        // before it in any window, even if a Resume here already followed.
        const seq = state.seq + 1;
        const paused = pauses.has(channelId);
        storage.savePauseState(channelId, {
          ...state,
          seq,
          paused,
          lastStopSeq: seq,
        });
        // This Stop cleared every Send now and Resume of this window's
        // clicked before it; ones still pending here came after it. A Stop
        // another window saved after such a click still cancels it.
        for (const entry of entries) {
          const approval = approvals.get(entry.id);
          if (
            entry.channelId === channelId &&
            approval &&
            approval.generation === state.generation &&
            approval.seq >= state.lastStopSeq
          )
            approvals.set(entry.id, { seq, generation: state.generation });
        }
        const pending = resumes.get(channelId);
        if (pending && overrides(pending, state)) pending.lastStopSeq = seq;
        if (!paused) return;
        const slipped =
          stop.handoffBefore !== undefined &&
          (await sentElsewhereSince(channelId, stop.handoffBefore));
        const current = pauses.get(channelId);
        if (
          current &&
          (!current.saved || (slipped && !current.sentBeforeStop))
        ) {
          const { saveError: _, ...rest } = current;
          pauses.set(channelId, {
            ...rest,
            ...(slipped ? { sentBeforeStop: true as const } : {}),
            saved: true,
          });
          pausesChanged();
          emit();
        }
      })
      .catch((error) => {
        // A Resume this window couldn't save still holds here, and says so,
        // until a newer saved Stop or the queue emptying ends it.
        if (
          resume &&
          resumes.get(channelId) === resume &&
          !pauses.has(channelId)
        ) {
          resumes.set(channelId, { ...resume, failed: true });
          emit();
        }
        const current = pauses.get(channelId);
        if (current) {
          pauses.set(channelId, {
            ...current,
            saved: false,
            saveError:
              "Queue paused in this window only. Couldn’t save the pause, so other windows or a restart may not keep it.",
          });
          pausesChanged();
          emit();
        }
        throw error;
      });
  }
  /** The chat's handoff marker now; undefined when it can't be read. */
  function handoffAt(channelId: string): HandoffMark | null | undefined {
    if (!storage) return undefined;
    try {
      const handoff = storage.handoff(channelId);
      return handoff ? { id: handoff.id, message: handoff.message } : null;
    } catch {
      return undefined;
    }
  }
  /** Whether another window has a saved row of this chat mid-handoff. */
  function sendingElsewhere(channelId: string) {
    if (!storage) return false;
    try {
      return storage
        .load()
        .some(
          (row) =>
            row.channelId === channelId &&
            row.sending === true &&
            !publishing.has(row.id) &&
            handedOff(channelId, row.id),
        );
    } catch {
      return false;
    }
  }
  /** The chat's handoff names this row with a recorded message. */
  function handedOff(channelId: string, id: string) {
    const handoff = storage?.handoff(channelId);
    return handoff?.id === id && !!handoff.message;
  }
  /**
   * Under the chat lock: another window recorded a publication since
   * `before`, for a new row or for the row it had claimed by then.
   */
  async function sentElsewhereSince(
    channelId: string,
    before: HandoffMark | null,
  ) {
    if (!storage) return false;
    try {
      const current = storage.handoff(channelId);
      // Only a recorded message is evidence; a claim whose publish threw
      // has none.
      if (
        !current?.message ||
        (current.id === before?.id && current.message === before.message)
      )
        return false;
      return current.owner !== (await storage.owner());
    } catch {
      return false;
    }
  }
  /** Saved rows include ones other windows queued before this one hears of them. */
  function savedRows(channelId: string) {
    if (!storage) return false;
    try {
      return storage.load().some((row) => row.channelId === channelId);
    } catch {
      // Unreadable storage may still hold rows; keep any pause.
      return true;
    }
  }
  /** Whether a row is held behind an unresolved hand-off until its own Send. */
  function held(id: string) {
    try {
      return !!storage?.held(id);
    } catch {
      return true;
    }
  }
  function showHold(entry: Entry) {
    entry.restored = true;
    entry.resumeCancelled = true;
    entry.error ??= UNRESOLVED_HANDOFF;
  }
  /**
   * Save a hold on every other row in the chat before anything can replace
   * the unresolved hand-off that is their only ordering evidence. Saved first,
   * so the hold survives a restart and interrupted-turn Resume.
   */
  function holdSuccessors(channelId: string, except?: string) {
    if (!storage) return;
    for (const row of storage.load())
      if (row.channelId === channelId && row.id !== except)
        storage.hold(row.id);
    for (const entry of entries)
      if (entry.channelId === channelId && entry.id !== except) showHold(entry);
  }
  // A pause holds back queued rows. With none left in any window, the next
  // message sends as usual, so an emptied chat clears its pause. Emptiness is
  // decided from saved rows under the chat lock, so a row another window
  // queued keeps the pause.
  function unpauseEmpty(channelId: string) {
    // A Resume this window couldn't save leaves the saved pause in place.
    const holding = () =>
      pauses.has(channelId) || !!resumes.get(channelId)?.failed;
    if (
      !holding() ||
      clearing.has(channelId) ||
      entries.some((entry) => entry.channelId === channelId) ||
      savedRows(channelId)
    )
      return;
    if (!storage) {
      if (pauses.get(channelId)?.sentBeforeStop) stopNotices.add(channelId);
      pauses.delete(channelId);
      pausesChanged();
      return;
    }
    clearing.add(channelId);
    void storage
      .lockChat(channelId, async () => {
        // A Stop that found rows, or a Resume, settles it instead.
        if (!holding() || savedRows(channelId)) return;
        // A new generation: a row queued into the old pause that this
        // check missed re-pauses the chat when it takes its `seq`.
        const state = storage.pauseState(channelId);
        storage.savePauseState(channelId, {
          ...state,
          seq: state.seq + 1,
          paused: false,
          generation: state.generation + 1,
        });
        // The note that a message went out after Stop outlives the pause.
        if (pauses.get(channelId)?.sentBeforeStop) stopNotices.add(channelId);
        resumes.delete(channelId);
        pauses.delete(channelId);
        pausesChanged();
        emit();
      })
      .catch(() => {})
      .finally(() => clearing.delete(channelId));
  }
  function pump() {
    if (activating) return;
    for (const [channelId, handoff] of handoffs) {
      if (
        !storage ||
        (!handoff.complete && !handoffFinished(handoff)) ||
        settlingHandoffs.has(channelId)
      )
        continue;
      settlingHandoffs.add(channelId);
      void storage
        .lockChat(channelId, async () => {
          if (handoffs.get(channelId) !== handoff) return;
          const current = storage.handoff(channelId);
          if (
            current?.id === handoff.id &&
            (!current.message || current.message === handoff.message)
          )
            storage.claim(channelId, { ...handoff, complete: true });
          if (handoffs.get(channelId) === handoff) handoffs.delete(channelId);
        })
        .catch((error) => {
          storageError = error instanceof Error ? error.message : String(error);
          emit();
        })
        .finally(() => {
          settlingHandoffs.delete(channelId);
          if (handoffs.get(channelId) !== handoff) pump();
        });
    }
    for (const channelId of new Set([
      ...waits.keys(),
      ...pauses.keys(),
      ...[...resumes]
        .filter(([, resume]) => resume.failed)
        .map(([channelId]) => channelId),
      ...entries.map((entry) => entry.channelId),
    ])) {
      if (
        entries.some(
          (entry) =>
            entry.channelId === channelId &&
            (publishing.has(entry.id) || releasing.has(entry.id)),
        )
      )
        continue;
      const manual = entries.filter(
        (entry) =>
          entry.channelId === channelId &&
          requested.has(entry.id) &&
          entry.ready?.() !== false,
      );
      if (manual.length) {
        for (const entry of manual) void release(entry);
        continue;
      }
      if (!entries.some((entry) => entry.channelId === channelId))
        unpauseEmpty(channelId);
      if (isPaused(channelId) || blockers(channelId)) continue;
      const first = entries.find((entry) => entry.channelId === channelId);
      if (first && !first.error && !first.restored && first.ready?.() !== false)
        void release(first);
    }
    if (
      !entries.length &&
      !waits.size &&
      !handoffs.size &&
      !session.outbox
        ?.snapshot()
        .some(
          (item) =>
            item.recovery?.key.startsWith("follow-up:") && !item.acknowledged,
        )
    ) {
      const dispose = stop;
      stop = undefined;
      dispose?.();
      observeStorage();
    }
  }
  async function remove(id: string, locked = false) {
    const entry = entries.find((item) => item.id === id);
    try {
      if (entry?.dismissedDelivery) {
        if (storage && entry.message && !locked) {
          await storage.lockChat(entry.channelId, () =>
            storage.lock(id, () => remove(id, true)),
          );
          reconcileDelivery();
          pump();
          return;
        }
        if (!(await clearDismissed(entry))) return;
      }
      if (entry?.deliveryId || (entry?.sending && publishing.has(id))) return;
      if (entry?.message && storage && navigator.locks && !locked) {
        await storage.tryLock(id, async () => {
          await remove(id, true);
          reconcileDelivery();
          pump();
        });
        return;
      }
      if (entry?.message && storage?.isSending(id)) {
        if (!session.outbox) return;
        const receipt = await session.outbox.recovery(followUpRecovery(id).key);
        if (receipt) {
          entry.deliveryId = receipt.event.id;
          entry.sending = true;
          emit();
          return;
        }
      }
      if (entry?.message) storage?.remove(id);
      requested.delete(id);
      approvals.delete(id);
      entries = entries.filter((item) => item.id !== id);
    } catch (error) {
      entries = entries.map((item) =>
        item.id === id
          ? {
              ...item,
              error: error instanceof Error ? error.message : String(error),
            }
          : item,
      );
    }
    emit();
  }
  function refreshSending() {
    for (const entry of entries) {
      if (!entry.sending || !storage || refreshingSending.has(entry.id))
        continue;
      refreshingSending.add(entry.id);
      // Wait for the current handoff to release ownership, including a window
      // closing or persistence failing without another storage event.
      void storage
        .lock(entry.id, async () => {
          if (!entries.includes(entry) || publishing.has(entry.id)) return;
          if (entry.dismissedDelivery) {
            await clearDismissed(entry);
            return;
          }
          await session.outbox?.ready();
          if (!entries.includes(entry)) return;
          if (!session.outbox) return;
          const receipt = await session.outbox.recovery(
            followUpRecovery(entry.id).key,
          );
          if (!entries.includes(entry)) return;
          if (!receipt && entry.deliveryId) {
            entry.dismissedDelivery = entry.deliveryId;
            await clearDismissed(entry);
            return;
          }
          entry.deliveryId = receipt?.event.id;
          entry.sending = !!entry.deliveryId;
          entries = [...entries];
          emit();
        })
        .catch(() => {})
        .finally(() => refreshingSending.delete(entry.id));
    }
  }
  const onStorage = () => {
    restore();
    if (entries.length) watch();
    emit();
    pump();
  };
  if (entries.length) watch();
  if (storage && session.outbox)
    void session.outbox
      .ready()
      .then(() => {
        if (
          session.outbox
            ?.snapshot()
            .some(
              (item) =>
                item.recovery?.key.startsWith("follow-up:") &&
                !item.acknowledged,
            )
        ) {
          watch();
          reconcileDelivery();
        }
      })
      .catch(() => {});
  return {
    snapshot: () => entries,
    storageError: () => storageError,
    subscribe(listener: () => void) {
      if (storage && !listeners.size) onStorage();
      listeners.add(listener);
      observeStorage();
      return () => {
        listeners.delete(listener);
        observeStorage();
      };
    },
    /** `validated` means the caller checked recipients just now; only a later release revalidates. */
    submit(submitted: Omit<Entry, "id">, validated = false) {
      // A saved row waits on its mentions plus, in an agent DM, that agent.
      const entry = submitted.message
        ? {
            ...submitted,
            recipients: followUpTargets(submitted.message, session.viewer),
          }
        : submitted;
      // Upload completion can arrive after the removal notification, even before
      // this queue exists. Reject before allocating a slot so upload recovery runs.
      if (
        !session.channels
          .list()
          .channels.some(
            (row) =>
              row.id === entry.channelId && (!row.readOnly || row.cached),
          )
      )
        throw new Error("This chat is no longer available for sending.");
      if (entry.message) restore();
      // A new message in the chat retires the note about the last Stop.
      if (stopNotices.delete(entry.channelId)) emit();
      if (entry.message && (!storage || storageError))
        throw new Error(
          storageError ?? "Queued message storage is unavailable.",
        );
      watch();
      if (
        (validated || !entry.beforeRelease) &&
        !isPaused(entry.channelId) &&
        !blockers(entry.channelId) &&
        !entries.some((item) => item.channelId === entry.channelId)
      )
        return sent(entry);
      if (entries.length >= 50)
        throw new Error(
          "The follow-up queue is full. Send or remove a queued message first.",
        );
      if (
        entry.message?.dmAgent &&
        entries.filter((item) => item.channelId === entry.channelId).length >=
          DM_QUEUE_LIMIT
      )
        throw new Error("Queue is full: remove one or send now.");
      const id = crypto.randomUUID();
      const createdAt = ++sequence;
      const row = { ...entry, id, createdAt, admitted: true };
      if (!entry.message) {
        entries = [...entries, row];
        watch();
        emit();
        pump();
        return undefined;
      }
      if (!storage) throw new Error("Queued message storage is unavailable.");
      const message = entry.message;
      // The row shows at once, but its durable admission takes the chat lock,
      // so the queue emptying in another window either sees the saved row
      // or ends its pause before this row reads it.
      admitting.add(id);
      entries = [...entries, row];
      watch();
      emit();
      return storage
        .lockChat(entry.channelId, async () => {
          if (!entries.some((item) => item.id === id)) return;
          let state: FollowUpPauseState | undefined;
          try {
            state = storage.pauseState(entry.channelId);
          } catch {
            // An unreadable pause also fails this row's release.
          }
          // The `seq` first: a failed row save then leaves only a gap in it.
          if (state)
            try {
              storage.savePauseState(entry.channelId, {
                ...state,
                seq: state.seq + 1,
              });
            } catch {
              throw new Error(
                "Could not save the queued message. Your draft has been kept.",
              );
            }
          storage.save({ ...message, id, createdAt });
          // Queued into the saved pause this same read found.
          const resume = resumes.get(entry.channelId);
          if (
            state?.paused &&
            !pauses.has(entry.channelId) &&
            !(resume && overrides(resume, state))
          ) {
            resumes.delete(entry.channelId);
            pauses.set(entry.channelId, { saved: true });
            pausesChanged();
          }
        })
        .then(
          () => {
            admitting.delete(id);
            emit();
            pump();
            return undefined;
          },
          (error: unknown) => {
            // Nothing was saved: the caller restores the draft.
            admitting.delete(id);
            entries = entries.filter((item) => item.id !== id);
            emit();
            pump();
            throw error;
          },
        );
    },
    /** Resume only the chats the runner is actually recovering. Seed the
     * request barriers before it reads/restarts them, including reconnects. */
    resumeAfter(
      agent: string,
      turns: Readonly<Record<string, string>>,
      beforePublish?: (entry: Pick<Entry, "channelId" | "recipients">) => void,
    ) {
      restore();
      const channels = new Set(Object.values(turns).filter(Boolean));
      for (const [message, channelId] of Object.entries(turns)) {
        if (!channelId) continue;
        let handoff: FollowUpHandoff | null | undefined;
        try {
          handoff = storage?.handoff(channelId);
        } catch (error) {
          storageError = error instanceof Error ? error.message : String(error);
        }
        const resumedHandoff =
          handoff &&
          !handoff.complete &&
          handoff.message === message &&
          handoff.recipients.includes(agent)
            ? handoff
            : undefined;
        if (resumedHandoff && storage) {
          handoffs.set(channelId, resumedHandoff);
          void storage
            .lockChat(channelId, async () => {
              const current = storage.handoff(channelId);
              if (current?.id !== resumedHandoff.id || current.complete) return;
              resumedHandoff.owner = await storage.owner();
              storage.claim(channelId, {
                ...current,
                owner: resumedHandoff.owner,
              });
            })
            .catch((error) => {
              storageError =
                error instanceof Error ? error.message : String(error);
              emit();
            });
        }
        if (
          !resumedHandoff &&
          !entries.some((entry) => entry.channelId === channelId)
        )
          continue;
        resumedRequests.add(`${agent}:${message}`);
        waits.set(channelId, [
          ...(waits.get(channelId) ?? []),
          { agent, message, resumed: true },
        ]);
      }
      entries = entries.map((entry) => {
        if (
          (entry.restored || entry.resumedBy) &&
          !entry.resumeCancelled &&
          !held(entry.id) &&
          channels.has(entry.channelId)
        ) {
          entry.resumedBy ??= new Set();
          for (const [request, channelId] of Object.entries(turns))
            if (channelId === entry.channelId)
              entry.resumedBy.add(`${agent}:${request}`);
          entry.restored = false;
          entry.beforePublish = () => beforePublish?.(entry);
        }
        return entry;
      });
      if (entries.length || handoffs.size) watch();
      emit();
      // Other agents in the same Resume decision seed their barriers first.
      queueMicrotask(pump);
    },
    /** A request positively abandoned by the runner is not completion evidence. */
    pauseAfter(agent: string, turns: Readonly<Record<string, string>>) {
      const channels = new Set(Object.values(turns));
      for (const channelId of channels) {
        if (!storage) continue;
        void storage
          .lockChat(channelId, async () => {
            const marker = storage.handoff(channelId);
            if (
              marker?.message &&
              marker.message in turns &&
              marker.recipients.includes(agent)
            ) {
              const recipients = marker.recipients.filter(
                (recipient) => recipient !== agent,
              );
              if (recipients.length)
                storage.claim(channelId, { ...marker, recipients });
              else storage.retire(channelId);
            }
          })
          .catch((error) => {
            storageError =
              error instanceof Error ? error.message : String(error);
            emit();
          });
      }
      for (const [channelId, handoff] of handoffs)
        if (
          handoff.message &&
          handoff.message in turns &&
          handoff.recipients.includes(agent)
        ) {
          const recipients = handoff.recipients.filter(
            (recipient) => recipient !== agent,
          );
          if (recipients.length)
            handoffs.set(channelId, { ...handoff, recipients });
          else handoffs.delete(channelId);
        }
      for (const [channelId, current] of waits) {
        const remaining = current.filter(
          (wait) =>
            !(
              wait.resumed &&
              wait.agent === agent &&
              wait.message &&
              wait.message in turns
            ),
        );
        if (remaining.length) waits.set(channelId, remaining);
        else waits.delete(channelId);
      }
      entries = entries.map((entry) => {
        if (
          (entry.recovered || entry.resumedBy) &&
          channels.has(entry.channelId)
        ) {
          entry.restored = true;
          entry.resumeCancelled = true;
        }
        return entry;
      });
      emit();
      pump();
    },
    edit(id: string) {
      const entry = entries.find((item) => item.id === id);
      if (
        !entry?.message ||
        !storage ||
        entry.sending ||
        publishing.has(id) ||
        edits.has(id)
      )
        throw new Error("This queued message is no longer available to edit.");
      // Its save still waits for the chat lock; there is nothing to edit yet.
      if (admitting.has(id))
        throw new Error("This message is still being queued. Try again.");
      const originalText = entry.text;
      edits.add(id);
      let closed = false;
      const cancel = () => {
        if (closed) return;
        closed = true;
        edits.delete(id);
        pump();
      };
      return {
        cancel,
        async save(text: string) {
          if (closed) throw new Error("This edit is no longer available.");
          if (
            !text.trim() &&
            !entry.message?.attachments.length &&
            !entry.message?.forward
          )
            throw new Error("Enter a message or keep an attachment.");
          await storage.lock(id, async () => {
            if (closed) throw new Error("This edit is no longer available.");
            const saved = storage.load().find((row) => row.id === id);
            if (!saved || saved.sending || entry.deliveryId)
              throw new Error(
                "This message has already been sent or removed. Your edit has been kept.",
              );
            if (saved.text !== originalText)
              throw new Error(
                "This message changed in another window. Your edit has been kept.",
              );
            storage.save({ ...saved, text });
            entry.text = text;
            if (entry.message) entry.message.text = text;
            entries = [...entries];
            emit();
          });
          cancel();
        },
      };
    },
    /** This chat's pause, if any; a new Map whenever any pause changes. */
    pauses: () => pauseView,
    /** Notes that outlive a pause, or a Resume this window couldn't save. */
    notices,
    /**
     * Stop pauses the chat's queue synchronously, before any await, so
     * automatic release stops in this window at once. Saving the pause runs
     * in parallel; its promise reports only that save, never the Stop.
     */
    pause(channelId: string): Promise<void> {
      if (
        !entries.some((entry) => entry.channelId === channelId) &&
        !savedRows(channelId)
      ) {
        // Nothing to hold; the last Stop's note no longer describes this one.
        if (stopNotices.delete(channelId)) emit();
        return Promise.resolve();
      }
      const handedOff = entries.some(
        (entry) =>
          entry.channelId === channelId &&
          entry.sending &&
          publishing.has(entry.id),
      );
      // Stop is the later intent: a Send now still short of its Outbox
      // handoff goes back to being a paused row. A later Send now still works.
      for (const entry of entries)
        if (
          entry.channelId === channelId &&
          requested.has(entry.id) &&
          !(entry.sending && publishing.has(entry.id))
        ) {
          requested.delete(entry.id);
          approvals.delete(entry.id);
        }
      resumes.delete(channelId);
      stopNotices.delete(channelId);
      const current = pauses.get(channelId);
      pauses.set(channelId, {
        ...(current?.sentBeforeStop || handedOff || sendingElsewhere(channelId)
          ? { sentBeforeStop: true as const }
          : {}),
      });
      pausesChanged();
      emit();
      return savePause(channelId, { handoffBefore: handoffAt(channelId) });
    },
    /** Resume queue: release this chat's held rows in order again. */
    resume(channelId: string): Promise<void> {
      // This Resume overrides only the saved Stop it sees now.
      if (storage) {
        let state: FollowUpPauseState | undefined;
        try {
          state = storage.pauseState(channelId);
        } catch {
          // The save below reports the same failure.
        }
        resumes.set(channelId, {
          lastStopSeq: state?.lastStopSeq ?? -1,
          generation: state?.generation ?? -1,
        });
      }
      pauses.delete(channelId);
      stopNotices.delete(channelId);
      pausesChanged();
      // An earlier hand-off with no completion evidence, left by a window
      // that is gone, holds every row restored behind it: each waits for its
      // own Send, so one Send never re-arms automatic release for the rest.
      let unresolved = false;
      try {
        const handoff = storage?.handoff(channelId);
        unresolved =
          !!handoff &&
          !handoff.complete &&
          !handoffFinished(handoff) &&
          handoff.id !== handoffs.get(channelId)?.id;
      } catch {
        unresolved = true;
      }
      // Rows restored with the pause wait for nothing else; rows paused for an
      // uncertain predecessor still need their own Send.
      entries = entries.map((entry) => {
        if (
          entry.channelId === channelId &&
          entry.restored &&
          !entry.predecessorRemoved &&
          !entry.error
        ) {
          if ((unresolved && entry.recovered) || held(entry.id)) {
            try {
              storage?.hold(entry.id);
            } catch {
              // The in-memory hold below still applies in this window.
            }
            showHold(entry);
          } else entry.restored = false;
        }
        return entry;
      });
      emit();
      const saved = savePause(channelId);
      watch();
      pump();
      return saved;
    },
    sendNow(id: string, beforePublish?: () => void) {
      const entry = entries.find((item) => item.id === id);
      if (entry) {
        requested.set(id, beforePublish);
        approvals.delete(id);
        if (storage && entry.message)
          try {
            const state = storage.pauseState(entry.channelId);
            approvals.set(id, {
              seq: state.seq,
              generation: state.generation,
            });
          } catch {
            // Without an approval the row waits in its place.
          }
        void release(entry);
      }
    },
    remove(id: string) {
      remove(id);
      reconcileDelivery();
      pump();
    },
    discardable: orphaned,
    /** Discard an unconfirmed send whose queue record is gone. */
    async discard(id: string) {
      const outbox = session.outbox;
      const current = () =>
        outbox?.snapshot().find((item) => item.event.id === id);
      const recovery = current()?.recovery;
      const changed = () =>
        new Error(
          "This message’s delivery changed. Cancel to see its current status.",
        );
      if (!storage || !outbox || !recovery || !orphaned(current()))
        throw changed();
      await storage.lock(recovery.value, async () => {
        if (!orphaned(current())) throw changed();
        await outbox.dismiss(id, recovery);
      });
    },
  };
}
