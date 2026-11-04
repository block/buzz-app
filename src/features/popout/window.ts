import { Channel, invoke } from "@tauri-apps/api/core";
import type { ReadingHandle } from "../relay/unread";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import type { ComposerReader } from "../huddle/composer-contract";
import { createHuddleComposerOwner } from "../huddle/composer-owner";
import { isBuzzLink } from "../navigation/buzz-links";
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
  | "send"
  | "older"
  | "retry"
  | "retryMessage"
  | "discardMessage"
  | "guard"
  | "close"
  | "reading"
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

/** Companion reading messages: bounded JSON carried by one native action. */
export type ReadingMessage =
  | { op: "acquire"; lease: string }
  | { op: "view"; lease: string; ids: string[] }
  | { op: "observe"; lease: string; ids: string[] }
  | { op: "catchUp"; lease: string; id: string }
  | { op: "dispose"; lease: string };
const MAX_LEASES = 8;
const hex = /^[0-9a-f]{64}$/;

type Entry = {
  label: string;
  session: RelaySession;
  scope: string;
  viewer: string;
  target: PopoutTarget;
  thread: ReturnType<typeof createPopoutThread>;
  composer: ReturnType<typeof createHuddleComposerOwner> | undefined;
  leases: Map<string, ReadingHandle>;
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
  // Why a window closed on its own; a mounted host component claims each once.
  let notices: readonly { id: number; text: string }[] = [];
  let noticeId = 0;
  const noticeListeners = new Set<() => void>();
  const notify = (text: string) => {
    notices = [...notices, { id: ++noticeId, text }].slice(-8);
    for (const listener of noticeListeners) listener();
  };
  const bridge = options.bridge ?? nativePopoutWindow;
  const incarnation = Date.now();
  let disposed = false;
  const entries = new Map<string, Entry>();
  let updates: Promise<unknown> = Promise.resolve();
  const chain = (work: () => Promise<unknown>) => {
    updates = updates.catch(() => {}).then(work);
    void updates.catch(() => {});
    return updates;
  };
  const dark = () => document.documentElement.classList.contains("dark");
  function view(entry: Entry): PopoutView {
    return {
      ...entry.thread.snapshot(),
      composer: entry.composer?.token,
      dark: dark(),
    };
  }
  function sync(entry: Entry) {
    if (entry.retired) return;
    const next = view(entry);
    void chain(() => bridge.update(entry.label, next));
  }
  function retire(entry: Entry, reason?: string) {
    if (entry.retired) return;
    entry.retired = true;
    entries.delete(entry.label);
    for (const lease of entry.leases.values()) lease.dispose();
    entry.leases.clear();
    entry.composer?.dispose();
    entry.thread.dispose();
    void chain(() => bridge.update(entry.label, null));
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
  function reading(entry: Entry, text: string) {
    let message: ReadingMessage;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (
      typeof message !== "object" ||
      !message ||
      typeof message.lease !== "string" ||
      message.lease.length > 64
    )
      return;
    const known = new Set(
      [entry.thread.snapshot().root, ...entry.thread.snapshot().replies]
        .filter((row) => row !== undefined)
        .map((row) => row.id),
    );
    const ids = (value: unknown) =>
      Array.isArray(value)
        ? value
            .filter(
              (id): id is string => typeof id === "string" && hex.test(id),
            )
            .filter((id) => known.has(id))
            .slice(0, 128)
        : [];
    const handle = entry.leases.get(message.lease);
    switch (message.op) {
      case "acquire": {
        if (handle || !entry.thread.snapshot().reading) return;
        if (entry.leases.size >= MAX_LEASES) {
          const oldest = entry.leases.keys().next().value;
          if (oldest) {
            entry.leases.get(oldest)?.dispose();
            entry.leases.delete(oldest);
          }
        }
        try {
          entry.leases.set(
            message.lease,
            entry.session.unread.reading(entry.target.channelId),
          );
        } catch {
          /* Membership may disappear between commit and observation. */
        }
        return;
      }
      case "view": {
        // Rows measured by the companion; nothing else is claimed visible.
        const measured = new Set(ids(message.ids));
        try {
          handle?.view([...measured], (id, known) => known && measured.has(id));
        } catch {
          entry.leases.delete(message.lease);
        }
        return;
      }
      case "observe": {
        const rows = ids(message.ids);
        if (handle && rows.length) void handle.observe(rows).catch(() => {});
        return;
      }
      case "catchUp": {
        if (handle && typeof message.id === "string" && known.has(message.id))
          void handle
            .catchUp(message.id, entry.target.threadRootId)
            .catch(() => {});
        return;
      }
      case "dispose": {
        // A disposed lease answers no later observation: delayed IPC cannot
        // revive reading intent cancelled by blur, hide or manual unread.
        handle?.dispose();
        entry.leases.delete(message.lease);
        return;
      }
    }
  }
  function act(control: PopoutControl) {
    const entry = entries.get(control.label);
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
      case "reading":
        if (text) reading(entry, text);
        return;
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
    const existing = [...entries.values()].find(
      (entry) =>
        entry.scope === scope &&
        entry.viewer === viewer &&
        entry.target.channelId === target.channelId &&
        entry.target.threadRootId === target.threadRootId,
    );
    const entry: Entry = existing ?? {
      label: "",
      session,
      scope,
      viewer,
      target,
      thread: createPopoutThread(
        session,
        target.channelId,
        target.threadRootId,
        () => {
          if (!entry.label) return;
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
      composer: undefined,
      leases: new Map(),
      retired: false,
    };
    if (!existing) {
      entry.composer = createHuddleComposerOwner(
        session,
        target.channelId,
        target.channelId,
        options.extensions,
        () => current(entry),
        () => entry.thread.available(),
        options.agents,
        target.threadRootId,
      );
    }
    const binding: PopoutBinding = { ...target, scope, viewer, incarnation };
    const opened = await chain(() => bridge.open(binding, view(entry), act));
    const { label, existing: focused } = opened as {
      label: string;
      existing: boolean;
    };
    if (existing || focused) {
      // Native already had this target: it was focused and keeps its owner.
      if (!existing) {
        entry.composer?.dispose();
        entry.thread.dispose();
      }
      return;
    }
    entry.label = label;
    entries.set(label, entry);
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
    for (const entry of [...entries.values()])
      if (!current(entry))
        retire(
          entry,
          `Closed the pop-out window: ${entry.thread.snapshot().title} (the community or session changed).`,
        );
  });
  const theme = new MutationObserver(() => {
    for (const entry of entries.values()) sync(entry);
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
      [...entries.values()].some(
        (entry) =>
          entry.target.channelId === target.channelId &&
          entry.target.threadRootId === target.threadRootId,
      ),
    async dispose() {
      disposed = true;
      stopRelay();
      theme.disconnect();
      for (const entry of [...entries.values()]) retire(entry);
      await updates.catch(() => {});
    },
  };
}
export type PopoutWindows = ReturnType<typeof createPopoutWindows>;
