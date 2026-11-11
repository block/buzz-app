import { Channel, invoke } from "@tauri-apps/api/core";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import type { ComposerReader } from "../huddle/composer-contract";
import { createHuddleComposerOwner } from "../huddle/composer-owner";
import { isBuzzLink } from "../navigation/buzz-links";
import { profileActivityViewKey } from "../profiles/target";
import {
  APPEARANCE_ATTRIBUTES,
  type DocumentAppearance,
  readDocumentAppearance,
} from "../../shared/theme/document-appearance";
import { createReadingOwner } from "./reading-bridge";
import {
  createPopoutDescriptors,
  type PopoutDescriptor,
  type PopoutDescriptors,
  type PopoutGeometry,
  validGeometry,
} from "./restore-state";
import { createPopoutThread, type PopoutThreadView } from "./thread";

/** A conversation (channel, DM, Solo chat) or one thread of it. */
export type PopoutTarget = {
  channelId: string;
  threadRootId?: string | undefined;
};
export type PopoutBinding = PopoutTarget & {
  scope: string;
  viewer: string;
  incarnation: number;
};
export type PopoutView = PopoutThreadView & {
  dark: boolean;
  /** The main window's applied appearance, mirrored by this window. */
  appearance?: DocumentAppearance | undefined;
  /** This frame was opened from the previous one; `back` returns there. */
  canGoBack?: boolean;
  closeRequested?: number;
  detached?: boolean;
};
export type PopoutAction =
  | "openLink"
  | "openInMain"
  | "openMembers"
  | "focusMain"
  | "openThread"
  | "back"
  | "older"
  | "retry"
  | "retryMessage"
  | "discardMessage"
  | "guard"
  | "close"
  | "closed"
  /** Native-owned: the window was moved or resized (text: geometry JSON). */
  | "geometry";
export type PopoutControl = {
  label: string;
  incarnation: number;
  action: PopoutAction;
  text?: string;
};
/** An automatic reopening: placed where it was, shown without taking focus. */
export type PopoutRestore = { geometry?: PopoutGeometry | undefined };
export type PopoutBridge = {
  open(
    binding: PopoutBinding,
    view: PopoutView,
    act: (control: PopoutControl) => void,
    restore?: PopoutRestore,
  ): Promise<{ label: string; existing: boolean }>;
  update(label: string, view: PopoutView | null): Promise<void>;
  detached(): Promise<string[]>;
};
export const nativePopoutWindow: PopoutBridge = {
  async open(binding, view, act, restore) {
    const actions = new Channel<PopoutControl>();
    actions.onmessage = act;
    return invoke("popout_window_open", {
      binding,
      view,
      actions,
      ...(restore ? { restore } : {}),
    });
  },
  update: (label, view) => invoke("popout_window_update", { label, view }),
  detached: () => invoke("popout_window_detached"),
};
const hex = /^[0-9a-f]{64}$/;

/** What a window shows at one point of its history: a projection, the
 * composer owner and the reading owner for one target. */
type Frame = {
  target: PopoutTarget;
  thread: ReturnType<typeof createPopoutThread>;
  composer: ReturnType<typeof createHuddleComposerOwner>;
  reading: ReturnType<typeof createReadingOwner>;
};
type Entry = {
  /** Empty while native creation is pending; the entry is owned regardless. */
  label: string;
  session: RelaySession;
  scope: string;
  viewer: string;
  /** The window's binding: what it was opened for (native dedupes on it). */
  target: PopoutTarget;
  /** Bottom first; the top frame is what the window shows. A conversation
   * window drills into one of its threads here, as Slack's does. */
  frames: Frame[];
  /** The companion holds work view state does not (files, a conflicted or
   * unsaved reply); a voluntary community exit names it before discarding. */
  held: boolean;
  retired: boolean;
};
const top = (entry: Entry) => entry.frames[entry.frames.length - 1] as Frame;
const MAX_FRAMES = 2;

/** Main-window owner of every pop-out. Companions are remote views; this is the
 * only place that reads the thread, sends, or publishes reading intent for them. */
export function createPopoutWindows(
  relay: RelayData,
  options: {
    bridge?: PopoutBridge;
    extensions?: ComposerReader | undefined;
    openLink?: (target: string) => boolean;
    agents?: import("../agents/service").Agents;
    /** Registered plugin message actions, offered as main-window handoffs. */
    actions?: import("../conversation/contracts").ContributionReader<
      import("../conversation/contracts").MessageAction
    >;
    /** Bring main to this message and name the action to choose there. */
    handoff?: (
      target: PopoutTarget,
      messageId: string,
      action: import("../../plugins/contributions").Contribution<
        import("../conversation/contracts").MessageAction
      >,
    ) => void;
    /** Open an agent's activity view beside this conversation in main. */
    openActivity?: (activityTarget: string, target: PopoutTarget) => void;
    /** Open the conversation's members/access in main (`solo`: no Members
     * surface exists; the conversation itself opens). */
    openMembers?: (channelId: string, solo: boolean) => void;
    /** Plugin chat icons, for a Solo window's header. */
    chatIcons?: import("../conversation/contracts").ContributionReader<
      import("../conversation/service").ChatIcon
    >;
  } = {},
) {
  const bridge = options.bridge ?? nativePopoutWindow;
  const incarnation = Date.now();
  let disposed = false;
  // Every owned window, including ones whose native creation is still pending.
  const entries = new Set<Entry>();
  let updates: Promise<unknown> = Promise.resolve();
  const chain = (work: () => Promise<unknown>) => {
    updates = updates.catch(() => {}).then(work);
    void updates.catch(() => {});
    return updates;
  };
  // Why a window closed on its own; a mounted host component claims each once.
  let notices: readonly { id: number; text: string }[] = [];
  let noticeId = 0;
  const noticeListeners = new Set<() => void>();
  const notify = (text: string) => {
    notices = [...notices, { id: ++noticeId, text }].slice(-8);
    for (const listener of noticeListeners) listener();
  };
  const holdListeners = new Set<() => void>();
  const appearance = () => readDocumentAppearance();
  const same = (a: PopoutTarget, b: PopoutTarget) =>
    a.channelId === b.channelId && a.threadRootId === b.threadRootId;
  type Roster = ReturnType<RelaySession["channels"]["list"]>;
  /** The roster covers the viewer's whole list and the relay has confirmed
   * every membership read from disk, so a conversation it lacks is gone
   * rather than unconfirmed. */
  const settled = (roster: Roster) =>
    roster.status === "ready" &&
    roster.coverage !== "partial" &&
    !roster.channels.some((channel) => channel.cached);
  const gone = (session: RelaySession, channelId: string) => {
    const roster = session.channels.list();
    return (
      settled(roster) &&
      !roster.channels.some((channel) => channel.id === channelId)
    );
  };
  // What reopens after a restart, per `origin:viewer` partition. Written on
  // open, drill, back, move and user close; a lifecycle end (owner disposal,
  // session or community change, app exit) is not a reason to forget a window.
  const descriptors = new Map<string, PopoutDescriptors>();
  const saved = (scope: string) => {
    let list = descriptors.get(scope);
    if (!list) {
      list = createPopoutDescriptors(scope);
      descriptors.set(scope, list);
    }
    return list;
  };
  const forget = (entry: Entry) => saved(entry.scope).forget(entry.target);
  function view(entry: Entry): PopoutView {
    const frame = top(entry);
    return {
      ...frame.thread.snapshot(),
      composer: frame.thread.writable() ? frame.composer.token : undefined,
      reading: frame.reading.token,
      dark: appearance().colorMode === "dark",
      appearance: appearance(),
      canGoBack: entry.frames.length > 1,
    };
  }
  const disposeFrame = (frame: Frame) => {
    frame.reading.dispose();
    frame.composer.dispose();
    frame.thread.dispose();
  };
  function sync(entry: Entry) {
    if (entry.retired || !entry.label) return;
    const next = view(entry);
    void chain(() => bridge.update(entry.label, next));
  }
  /** Release owner resources; a created window is destroyed natively. */
  function retire(entry: Entry, reason?: string) {
    if (entry.retired) return;
    entry.retired = true;
    entries.delete(entry);
    if (entry.held) for (const listener of holdListeners) listener();
    for (const frame of entry.frames) disposeFrame(frame);
    if (entry.label) void chain(() => bridge.update(entry.label, null));
    if (reason) notify(reason);
  }
  const current = (entry: Entry) => {
    const connection = relay.snapshot();
    return (
      !disposed &&
      !entry.retired &&
      connection.session === entry.session &&
      connection.scope === entry.scope &&
      connection.viewer === entry.viewer
    );
  };
  function act(control: PopoutControl) {
    const entry = [...entries].find((e) => e.label === control.label);
    if (!entry || control.incarnation !== incarnation) return;
    if (control.action === "closed") {
      // Native destroyed a window this owner still held: the person closed
      // it, unless it closed for main's close (`kept`) and stays saved.
      // Owner-driven ends retire first and never reach here; app exit is not
      // reported at all.
      if (control.text !== "kept") forget(entry);
      retire(entry);
      return;
    }
    if (!current(entry)) return;
    const text = control.text;
    switch (control.action) {
      case "geometry": {
        if (!text || text.length > 256) return;
        let geometry: unknown;
        try {
          geometry = JSON.parse(text);
        } catch {
          return;
        }
        if (validGeometry(geometry))
          saved(entry.scope).patch(entry.target, { geometry });
        return;
      }
      case "openLink":
        if (!text || !isBuzzLink(text) || text.length > 8192) return;
        // An agent's activity view opens beside this conversation in main,
        // through the existing target opener; other Buzz links navigate.
        if (profileActivityViewKey(text))
          options.openActivity?.(text, top(entry).target);
        else options.openLink?.(text);
        return;
      case "focusMain":
        return; // Native handles it and forwards nothing.
      case "openMembers": {
        const frame = top(entry);
        options.openMembers?.(
          frame.target.channelId,
          frame.thread.snapshot().kind === "solo",
        );
        return;
      }
      case "openInMain": {
        const { channelId, threadRootId } = top(entry).target;
        options.openLink?.(
          threadRootId
            ? `buzz://message?channel=${encodeURIComponent(channelId)}&id=${threadRootId}&thread=${threadRootId}`
            : `buzz://channel/${encodeURIComponent(channelId)}`,
        );
        return;
      }
      case "openThread": {
        // A conversation frame drills into one of the threads it shows; the
        // thread frame itself never opens anything further.
        const frame = top(entry);
        if (
          !text ||
          !hex.test(text) ||
          frame.target.threadRootId ||
          entry.frames.length >= MAX_FRAMES ||
          !frame.thread.shown(text)
        )
          return;
        entry.frames.push(
          createFrame(entry, {
            channelId: frame.target.channelId,
            threadRootId: text,
          }),
        );
        // The hidden frame's reading leases end now: only the shown frame
        // marks anything read.
        frame.reading.revoke();
        saved(entry.scope).patch(entry.target, { frameRootId: text });
        sync(entry);
        return;
      }
      case "back": {
        if (entry.frames.length < 2) return;
        const frame = entry.frames.pop() as Frame;
        disposeFrame(frame);
        saved(entry.scope).patch(entry.target, { frameRootId: undefined });
        sync(entry);
        return;
      }
      case "older":
        top(entry).thread.older();
        return;
      case "retry":
        top(entry).thread.retry();
        return;
      case "retryMessage":
      case "discardMessage":
        if (text)
          top(entry).thread.recover(text, control.action === "discardMessage");
        return;
      case "guard": {
        const held = text === "1";
        if (entry.held !== held) {
          entry.held = held;
          for (const listener of holdListeners) listener();
        }
        return;
      }
      default:
        return;
    }
  }
  /** The projection, composer owner and reading owner for one target of a
   * window; the window's binding (session, scope, viewer) is the entry's. */
  function createFrame(entry: Entry, target: PopoutTarget): Frame {
    const { session } = entry;
    const frame: Frame = {
      target,
      thread: createPopoutThread(
        session,
        target.channelId,
        target.threadRootId,
        () => {
          if (!entry.label || entry.retired || top(entry) !== frame) return;
          // Revocation: the roster is known and the channel is gone or cached.
          if (
            !frame.thread.available() &&
            session.channels.list().status === "ready" &&
            session.channels.list().coverage !== "partial"
          ) {
            // Cached membership closes the window but is unknown, not gone:
            // only a settled roster lacking the conversation forgets it.
            if (gone(session, target.channelId)) forget(entry);
            retire(
              entry,
              `Closed the pop-out window: ${frame.thread.snapshot().title} is no longer available.`,
            );
          } else sync(entry);
        },
        options.actions,
        undefined,
        options.agents,
        options.chatIcons,
      ),
      composer: undefined as unknown as Frame["composer"],
      reading: undefined as unknown as Frame["reading"],
    };
    frame.composer = createHuddleComposerOwner(
      session,
      target.channelId,
      target.channelId,
      options.extensions,
      () => current(entry) && top(entry) === frame,
      // Admission needs the verified root of this exact thread (or a ready
      // conversation), not only a joined channel; rechecked after async work.
      () => frame.thread.rootVerified(),
      options.agents,
      target.threadRootId,
      {
        message: (id) => frame.thread.shown(id),
        reactionBusy: (id) => frame.thread.reactionBusy(id),
        retryOperation: (id) => frame.thread.retryOperation(id),
        version: () => frame.thread.snapshot().version,
        root: () =>
          target.threadRootId
            ? frame.thread.shown(target.threadRootId)
            : undefined,
        admit: (id, messageId, kind) => {
          frame.thread.admit(id, messageId, kind);
          if (top(entry) === frame) sync(entry);
        },
        authorization: (id) => frame.thread.authorization(id),
        handoff: (messageId, key, revision) => {
          const action = frame.thread.handoff(messageId, key, revision);
          if (!action || !current(entry)) return false;
          options.handoff?.(frame.target, messageId, action);
          return true;
        },
        acknowledge: (ids) => {
          // Retiring reports may let a capped presentation show others.
          if (frame.thread.acknowledge(ids) && top(entry) === frame)
            sync(entry);
        },
        // Only the frame on top stops work: a covered frame's controls are
        // not what the window shows.
        stopWork: (key) =>
          current(entry) && top(entry) === frame
            ? frame.thread.stopWork(key)
            : undefined,
      },
    );
    frame.reading = createReadingOwner(
      session.unread,
      target.channelId,
      target.threadRootId,
      () => frame.thread.known(),
      () =>
        current(entry) && top(entry) === frame && frame.thread.readingEnabled(),
    );
    return frame;
  }
  /** Open a window for a target in the ready session. A restore reopens a
   * saved window: its drilled frame is rebuilt through the same reader and
   * verification as a live drill (not replayed through `openThread`, whose
   * gate needs the root among loaded rows), and native places it without
   * taking focus. */
  async function admit(target: PopoutTarget, restore?: PopoutDescriptor) {
    if (disposed) throw new Error("Pop-out windows are unavailable.");
    const connection = relay.snapshot();
    const { session, scope, viewer } = connection;
    if (connection.status !== "ready" || !scope || !viewer)
      throw new Error("Connect to the community before opening a window.");
    if (!target.channelId || target.channelId.length > 256)
      throw new Error("Invalid conversation.");
    if (target.threadRootId !== undefined && !hex.test(target.threadRootId))
      throw new Error("Invalid thread.");
    const existing = [...entries].find(
      (entry) =>
        entry.scope === scope &&
        entry.viewer === viewer &&
        same(entry.target, target),
    );
    if (existing) {
      // Native focuses the window for this binding; the owner is unchanged.
      if (existing.label && !restore)
        await chain(() =>
          bridge.open(
            { ...target, scope, viewer, incarnation },
            view(existing),
            act,
          ),
        );
      return;
    }
    const entry: Entry = {
      label: "",
      session,
      scope,
      viewer,
      target,
      frames: [],
      held: false,
      retired: false,
    };
    entry.frames.push(createFrame(entry, target));
    if (restore?.frameRootId && !target.threadRootId) {
      entry.frames.push(
        createFrame(entry, {
          channelId: target.channelId,
          threadRootId: restore.frameRootId,
        }),
      );
      (entry.frames[0] as Frame).reading.revoke();
    }
    // Owned before creation: a scope change or disposal during the native
    // await retires it, and completion below then destroys the new window.
    entries.add(entry);
    let opened: { label: string; existing: boolean };
    try {
      opened = (await chain(() =>
        bridge.open(
          { ...target, scope, viewer, incarnation },
          view(entry),
          act,
          restore && { geometry: restore.geometry },
        ),
      )) as { label: string; existing: boolean };
    } catch (error) {
      retire(entry);
      throw error;
    }
    if (entry.retired || !current(entry)) {
      // Stale by the time native finished: destroy what it created.
      entry.label = opened.label;
      if (entry.retired) void chain(() => bridge.update(opened.label, null));
      else retire(entry);
      return;
    }
    if (opened.existing) {
      // Native already had this binding (it was focused); keep one owner.
      retire(entry);
      return;
    }
    entry.label = opened.label;
    if (!restore)
      saved(scope).upsert({
        channelId: target.channelId,
        threadRootId: target.threadRootId,
      });
    sync(entry);
  }
  const open = (target: PopoutTarget) => admit(target);
  // Windows left by an earlier main renderer keep cached rows; this incarnation
  // cannot own their actions, so it retires them. The saved list then reopens
  // them, as it does after a restart.
  const detached = chain(async () => {
    try {
      for (const label of await bridge.detached())
        await bridge.update(label, null);
    } catch {
      /* No native host, or nothing detached. */
    }
  });
  // Each session's saved windows reopen once, after its roster is known so a
  // conversation that is definitively gone is forgotten rather than opened
  // and revoked. A batch stops at the first stale session or failure and
  // leaves the list as it was; the unopened windows stay saved.
  const restored = new WeakSet<RelaySession>();
  let rosterWatch: { session: RelaySession; stop: () => void } | undefined;
  const unwatchRoster = () => {
    rosterWatch?.stop();
    rosterWatch = undefined;
  };
  let restoring: { session: RelaySession; stop: () => void } | undefined;
  const stopRestoring = () => {
    restoring?.stop();
    restoring = undefined;
  };
  /** Reopens saved windows as the roster confirms their conversations. One
   * listed from disk with membership unconfirmed waits for the relay, as does
   * one missing while any membership is unconfirmed; one a settled roster
   * lacks is forgotten. The batch ends when every saved window is decided or
   * the session or scope moves on. */
  function restore(session: RelaySession, scope: string) {
    const list = saved(scope);
    const fresh = () => {
      const now = relay.snapshot();
      return (
        !disposed &&
        now.session === session &&
        now.scope === scope &&
        now.status === "ready"
      );
    };
    const key = (d: PopoutDescriptor) =>
      `${d.channelId}\n${d.threadRootId ?? ""}`;
    const decided = new Set<string>();
    let running = false;
    let again = false;
    // A continuation resumed after native creation ends only its own batch:
    // a newer session's may have replaced it meanwhile.
    const batch = {
      session,
      stop: session.channels.subscribeList(() => void attempt()),
    };
    const end = () => {
      if (restoring === batch) stopRestoring();
    };
    async function attempt() {
      if (running) {
        again = true;
        return;
      }
      running = true;
      let skipped = 0;
      try {
        do {
          again = false;
          for (const saved of list.snapshot()) {
            if (!fresh()) return end();
            // A window closed or changed while earlier ones were being
            // created reopens as it is saved now, or not at all.
            const descriptor = list.find(saved);
            if (!descriptor || decided.has(key(descriptor))) continue;
            const roster = session.channels.list();
            if (roster.status !== "ready") break;
            const channel = roster.channels.find(
              (c) => c.id === descriptor.channelId,
            );
            // Unconfirmed memberships wait for the relay; a partial roster
            // decides nothing, so an unlisted conversation reopens as before.
            const unconfirmed = roster.channels.some((c) => c.cached);
            if (channel?.cached || (!channel && unconfirmed)) continue;
            decided.add(key(descriptor));
            if (!channel && settled(roster)) {
              list.forget(descriptor);
              skipped += 1;
              continue;
            }
            try {
              await admit(
                {
                  channelId: descriptor.channelId,
                  threadRootId: descriptor.threadRootId,
                },
                descriptor,
              );
            } catch {
              return end();
            }
          }
        } while (again);
        if (!list.snapshot().some((d) => !decided.has(key(d)))) end();
      } finally {
        running = false;
        if (skipped)
          notify(
            skipped === 1
              ? "Didn’t reopen a pop-out window: its conversation is no longer available."
              : `Didn’t reopen ${skipped} pop-out windows: their conversations are no longer available.`,
          );
      }
    }
    stopRestoring();
    restoring = batch;
    void attempt();
  }
  function restoreWhenReady() {
    const connection = relay.snapshot();
    const { session, scope } = connection;
    if (restoring && restoring.session !== session) stopRestoring();
    if (disposed || connection.status !== "ready" || !scope) return;
    if (restored.has(session)) return;
    if (rosterWatch && rosterWatch.session !== session) unwatchRoster();
    if (session.channels.list().status !== "ready") {
      rosterWatch ??= {
        session,
        stop: session.channels.subscribeList(() => {
          if (session.channels.list().status !== "ready") return;
          unwatchRoster();
          restoreWhenReady();
        }),
      };
      return;
    }
    unwatchRoster();
    restored.add(session);
    void detached.then(() => restore(session, scope));
  }
  const stopRelay = relay.subscribe(() => {
    for (const entry of [...entries])
      if (!current(entry))
        retire(
          entry,
          `Closed the pop-out window: ${top(entry).thread.snapshot().title} (the community or session changed).`,
        );
    restoreWhenReady();
  });
  restoreWhenReady();
  const theme = new MutationObserver(() => {
    for (const entry of entries) sync(entry);
  });
  theme.observe(document.documentElement, {
    attributes: true,
    attributeFilter: APPEARANCE_ATTRIBUTES,
  });
  return {
    open,
    notices: {
      push: notify,
      snapshot: () => notices,
      subscribe(listener: () => void) {
        noticeListeners.add(listener);
        return () => {
          noticeListeners.delete(listener);
        };
      },
      claim(id: number) {
        const claimed = notices.some((notice) => notice.id === id);
        if (claimed) notices = notices.filter((notice) => notice.id !== id);
        return claimed;
      },
    },
    isOpen: (target: PopoutTarget) =>
      [...entries].some((entry) => same(entry.target, target)),
    /** Windows whose unsent work a community exit would discard, named. */
    held: () =>
      [...entries]
        .filter((entry) => entry.held && !entry.retired)
        .map(
          (entry) =>
            `The pop-out window for “${top(entry).thread.snapshot().title}” has an unsent reply.`,
        ),
    subscribeHeld(listener: () => void) {
      holdListeners.add(listener);
      return () => {
        holdListeners.delete(listener);
      };
    },
    async dispose() {
      disposed = true;
      stopRelay();
      unwatchRoster();
      stopRestoring();
      theme.disconnect();
      for (const entry of [...entries]) retire(entry);
      await updates.catch(() => {});
    },
  };
}
export type PopoutWindows = ReturnType<typeof createPopoutWindows>;
