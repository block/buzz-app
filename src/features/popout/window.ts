import { Channel, invoke } from "@tauri-apps/api/core";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import type { ComposerReader } from "../huddle/composer-contract";
import { createHuddleComposerOwner } from "../huddle/composer-owner";
import { isBuzzLink } from "../navigation/buzz-links";
import { createReadingOwner } from "./reading-bridge";
import { createPopoutThread, type PopoutThreadView } from "./thread";

export type PopoutTarget = { channelId: string; threadRootId: string };
export type PopoutBinding = PopoutTarget & {
  scope: string;
  viewer: string;
  incarnation: number;
};
export type PopoutView = PopoutThreadView & {
  dark: boolean;
  closeRequested?: number;
  detached?: boolean;
};
export type PopoutAction =
  | "openLink"
  | "openInMain"
  | "older"
  | "retry"
  | "retryMessage"
  | "discardMessage"
  | "guard"
  | "close"
  | "closed";
export type PopoutControl = {
  label: string;
  incarnation: number;
  action: PopoutAction;
  text?: string;
};
export type PopoutBridge = {
  open(
    binding: PopoutBinding,
    view: PopoutView,
    act: (control: PopoutControl) => void,
  ): Promise<{ label: string; existing: boolean }>;
  update(label: string, view: PopoutView | null): Promise<void>;
  detached(): Promise<string[]>;
};
export const nativePopoutWindow: PopoutBridge = {
  async open(binding, view, act) {
    const actions = new Channel<PopoutControl>();
    actions.onmessage = act;
    return invoke("popout_window_open", { binding, view, actions });
  },
  update: (label, view) => invoke("popout_window_update", { label, view }),
  detached: () => invoke("popout_window_detached"),
};
const hex = /^[0-9a-f]{64}$/;

type Entry = {
  /** Empty while native creation is pending; the entry is owned regardless. */
  label: string;
  session: RelaySession;
  scope: string;
  viewer: string;
  target: PopoutTarget;
  thread: ReturnType<typeof createPopoutThread>;
  composer: ReturnType<typeof createHuddleComposerOwner>;
  reading: ReturnType<typeof createReadingOwner>;
  /** The companion holds work view state does not (files, a conflicted or
   * unsaved reply); a voluntary community exit names it before discarding. */
  held: boolean;
  retired: boolean;
};

/** Main-window owner of every pop-out. Companions are remote views; this is the
 * only place that reads the thread, sends, or publishes reading intent for them. */
export function createPopoutWindows(
  relay: RelayData,
  options: {
    bridge?: PopoutBridge;
    extensions?: ComposerReader | undefined;
    openLink?: (target: string) => boolean;
    agents?: import("../agents/service").Agents;
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
  const dark = () => document.documentElement.classList.contains("dark");
  const same = (a: PopoutTarget, b: PopoutTarget) =>
    a.channelId === b.channelId && a.threadRootId === b.threadRootId;
  function view(entry: Entry): PopoutView {
    return {
      ...entry.thread.snapshot(),
      composer: entry.thread.writable() ? entry.composer.token : undefined,
      reading: entry.reading.token,
      dark: dark(),
    };
  }
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
    entry.reading.dispose();
    entry.composer.dispose();
    entry.thread.dispose();
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
      retire(entry);
      return;
    }
    if (!current(entry)) return;
    const text = control.text;
    switch (control.action) {
      case "openLink":
        if (text && isBuzzLink(text) && text.length <= 8192)
          options.openLink?.(text);
        return;
      case "openInMain":
        options.openLink?.(
          `buzz://message?channel=${encodeURIComponent(entry.target.channelId)}&id=${entry.target.threadRootId}&thread=${entry.target.threadRootId}`,
        );
        return;
      case "older":
        entry.thread.older();
        return;
      case "retry":
        entry.thread.retry();
        return;
      case "retryMessage":
      case "discardMessage":
        if (text)
          entry.thread.recover(text, control.action === "discardMessage");
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
  async function open(target: PopoutTarget) {
    if (disposed) throw new Error("Pop-out windows are unavailable.");
    const connection = relay.snapshot();
    const { session, scope, viewer } = connection;
    if (connection.status !== "ready" || !scope || !viewer)
      throw new Error("Connect to the community before opening a window.");
    if (!hex.test(target.threadRootId)) throw new Error("Invalid thread.");
    const existing = [...entries].find(
      (entry) =>
        entry.scope === scope &&
        entry.viewer === viewer &&
        same(entry.target, target),
    );
    if (existing) {
      // Native focuses the window for this binding; the owner is unchanged.
      if (existing.label)
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
      retired: false,
      thread: createPopoutThread(
        session,
        target.channelId,
        target.threadRootId,
        () => {
          if (!entry.label || entry.retired) return;
          // Revocation: the roster is known and the channel is gone or cached.
          if (
            !entry.thread.available() &&
            session.channels.list().status === "ready" &&
            session.channels.list().coverage !== "partial"
          )
            retire(
              entry,
              `Closed the pop-out window: ${entry.thread.snapshot().title} is no longer available.`,
            );
          else sync(entry);
        },
      ),
      composer: undefined as unknown as Entry["composer"],
      reading: undefined as unknown as Entry["reading"],
      held: false,
    };
    entry.composer = createHuddleComposerOwner(
      session,
      target.channelId,
      target.channelId,
      options.extensions,
      () => current(entry),
      // Admission needs the verified root of this exact thread, not only a
      // joined channel; the owner rechecks this after async preparation.
      () => entry.thread.rootVerified(),
      options.agents,
      target.threadRootId,
    );
    entry.reading = createReadingOwner(
      session.unread,
      target.channelId,
      target.threadRootId,
      () => entry.thread.known(),
      () => current(entry) && entry.thread.readingEnabled(),
    );
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
    sync(entry);
  }
  // Windows left by an earlier main renderer keep cached rows; this incarnation
  // cannot own their actions, so it retires them (re-adoption is not in S1).
  void chain(async () => {
    try {
      for (const label of await bridge.detached())
        await bridge.update(label, null);
    } catch {
      /* No native host, or nothing detached. */
    }
  });
  const stopRelay = relay.subscribe(() => {
    for (const entry of [...entries])
      if (!current(entry))
        retire(
          entry,
          `Closed the pop-out window: ${entry.thread.snapshot().title} (the community or session changed).`,
        );
  });
  const theme = new MutationObserver(() => {
    for (const entry of entries) sync(entry);
  });
  theme.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return {
    open,
    notices: {
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
            `The pop-out window for “${entry.thread.snapshot().title}” has an unsent reply.`,
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
      theme.disconnect();
      for (const entry of [...entries]) retire(entry);
      await updates.catch(() => {});
    },
  };
}
export type PopoutWindows = ReturnType<typeof createPopoutWindows>;
