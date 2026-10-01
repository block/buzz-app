import { Channel, invoke } from "@tauri-apps/api/core";
import type { RelayData } from "../relay/service";
import { formatPublicKey } from "../../shared/identity/public-key";
import type { Huddles } from "./service";
import { createHuddleDiscussion, type HuddleDiscussion } from "./discussion";

export type HuddleView = {
  id: string;
  title: string;
  phase: "connecting" | "connected" | "leaving";
  muted: boolean;
  level: number;
  dark: boolean;
  discussion?: HuddleDiscussion | undefined;
  participants: {
    key: string;
    name: string;
    picture: string | null;
    own: boolean;
    level: number;
  }[];
};
export type HuddleAction =
  | "mute"
  | "leave"
  | "minimize"
  | "thread"
  | "send"
  | "older"
  | "retry"
  | "retryMessage"
  | "discardMessage";
export type HuddleWindowAction = HuddleAction | "closed";
export type WindowBridge = {
  open(
    view: HuddleView,
    act: (id: string, action: HuddleWindowAction, text?: string) => void,
  ): Promise<void>;
  update(id: string, view: HuddleView | null): Promise<void>;
};
let sentDiscussion: { id: string; version: number | undefined } | undefined;
export const nativeHuddleWindow: WindowBridge = {
  async open(view, act) {
    const actions = new Channel<{
      id: string;
      action: HuddleWindowAction;
      text?: string;
    }>();
    actions.onmessage = ({ id, action, text }) => act(id, action, text);
    await invoke("huddle_window_open", {
      view: { ...view, discussionOpen: !!view.discussion },
      actions,
    });
    sentDiscussion = { id: view.id, version: view.discussion?.version };
  },
  async update(id, view) {
    const unchanged =
      sentDiscussion?.id === id &&
      sentDiscussion.version === view?.discussion?.version;
    await invoke("huddle_window_update", {
      id,
      view: view && {
        ...view,
        discussionOpen: !!view.discussion,
        discussion: unchanged ? undefined : view.discussion,
      },
    });
    sentDiscussion = view
      ? { id, version: view.discussion?.version }
      : undefined;
  },
};

/** Companion is a remote view; only this main-window owner can operate the call. */
export function createHuddleWindow(
  huddles: Huddles,
  relay: RelayData,
  bridge = nativeHuddleWindow,
) {
  let disposed = false;
  let attempted: string | undefined;
  let revision = 0;
  let presentation = { visible: false, failed: false };
  const listeners = new Set<() => void>();
  function publish(visible: boolean, failed = false) {
    if (presentation.visible === visible && presentation.failed === failed)
      return;
    presentation = { visible, failed };
    for (const listener of listeners) listener();
  }
  let opened: string | undefined;
  let opening: Promise<void> | undefined;
  let stopProfiles: (() => void) | undefined;
  let ensured = "";
  let discussion: ReturnType<typeof createHuddleDiscussion> | undefined;
  const closeDiscussion = () => {
    discussion?.dispose();
    discussion = undefined;
  };
  // Serialize updates with window creation so Leave during Open cannot orphan a view.
  let updates = Promise.resolve();
  function view(): HuddleView | null {
    const call = huddles.snapshot();
    if (
      !call.id ||
      !call.destination ||
      !["connecting", "connected", "leaving"].includes(call.phase)
    )
      return null;
    const session = relay.snapshot().session;
    const profiles = session.profiles.snapshot();
    return {
      id: call.id,
      title: call.destination.channelName,
      phase: call.phase as HuddleView["phase"],
      muted: call.muted,
      level: call.level ?? 0,
      dark: document.documentElement.classList.contains("dark"),
      discussion: discussion?.snapshot(),
      participants: call.participants.map((key) => {
        const profile = profiles.get(key);
        return {
          key,
          name: profile?.name || formatPublicKey(key) || "Participant",
          picture: profile?.picture
            ? (session.media(profile.picture) ?? null)
            : null,
          own: key === call.destination?.viewer,
          level: call.speakers?.[key] ?? 0,
        };
      }),
    };
  }
  function sync() {
    if (opening) return;
    const next = disposed ? null : view();
    if (next?.phase === "connected" && attempted !== next.id) {
      void open().catch(() => {});
      return;
    }
    if (!opened) {
      if (!next) publish(false);
      return;
    }
    const id = opened;
    const live = next?.id === id ? next : null;
    updates = updates.catch(() => {}).then(() => bridge.update(id, live));
    // Observe errors, allowing the next update or explicit Open to recover.
    void updates.catch(() => {});
    if (!live) {
      closeDiscussion();
      publish(false);
      opened = undefined;
      stopProfiles?.();
      stopProfiles = undefined;
    } else {
      const keys = live.participants.map((p) => p.key).join(":");
      if (keys !== ensured) {
        ensured = keys;
        void relay
          .snapshot()
          .session.profiles.ensure(
            live.participants.map((p) => p.key),
            "background",
          )
          .catch(() => {});
      }
    }
  }
  const stop = huddles.subscribe(sync);
  const theme = new MutationObserver(sync);
  theme.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  async function open() {
    if (disposed) return;
    if (opening) return opening;
    const next = view();
    if (next?.phase !== "connected") return;
    const version = ++revision;
    attempted = next.id;
    publish(true);
    stopProfiles?.();
    stopProfiles = relay.snapshot().session.profiles.subscribe(sync);
    opened = next.id;
    opening = (async () => {
      await updates.catch(() => {});
      try {
        await bridge.open(next, (id, action, text) => {
          if (disposed || revision !== version || huddles.snapshot().id !== id)
            return;
          if (action === "closed" || action === "minimize") {
            if (opened !== id) return;
            opened = undefined;
            closeDiscussion();
            stopProfiles?.();
            stopProfiles = undefined;
            updates = updates
              .catch(() => {})
              .then(() => bridge.update(id, null));
            void updates.catch(() => {});
            publish(false);
          } else if (action === "mute") huddles.mute();
          else if (action === "leave") void huddles.leave();
          else if (action === "thread") {
            const call = huddles.snapshot();
            if (discussion) closeDiscussion();
            else if (
              call.room &&
              call.destination &&
              call.phase === "connected"
            )
              discussion = createHuddleDiscussion(
                relay.snapshot().session,
                call.room,
                call.destination.channelId,
                sync,
              );
            sync();
          } else if (action === "send" && typeof text === "string")
            void discussion?.send(text);
          else if (action === "older") discussion?.older();
          else if (action === "retry") discussion?.retry();
          else if (
            (action === "retryMessage" || action === "discardMessage") &&
            text
          )
            discussion?.recover(text, action === "discardMessage");
        });
      } catch (error) {
        // Include partial-creation cleanup in the promise disposal waits for.
        try {
          await bridge.update(next.id, null);
        } finally {
          opened = undefined;
          stopProfiles?.();
          stopProfiles = undefined;
          publish(false, true);
        }
        throw error;
      } finally {
        opening = undefined;
        sync();
      }
    })();
    return opening;
  }
  return {
    open,
    snapshot: () => presentation,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async dispose() {
      disposed = true;
      closeDiscussion();
      stop();
      theme.disconnect();
      await opening?.catch(() => {});
      sync();
      stopProfiles?.();
      await updates;
    },
  };
}
export type HuddleWindow = ReturnType<typeof createHuddleWindow>;
