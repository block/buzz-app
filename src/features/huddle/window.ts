import { Channel, invoke } from "@tauri-apps/api/core";
import type { RelayData } from "../relay/service";
import { formatPublicKey } from "../../shared/identity/public-key";
import type { Huddles } from "./service";

export type HuddleView = {
  id: string;
  title: string;
  phase: "connecting" | "connected" | "leaving";
  muted: boolean;
  level: number;
  dark: boolean;
  participants: {
    key: string;
    name: string;
    picture: string | null;
    own: boolean;
    level: number;
  }[];
};
export type HuddleAction = "mute" | "leave";
export type HuddleWindowAction = HuddleAction | "closed";
export type WindowBridge = {
  open(
    view: HuddleView,
    act: (id: string, action: HuddleWindowAction) => void,
  ): Promise<void>;
  update(id: string, view: HuddleView | null): Promise<void>;
};
export const nativeHuddleWindow: WindowBridge = {
  open(view, act) {
    const actions = new Channel<{ id: string; action: HuddleWindowAction }>();
    actions.onmessage = ({ id, action }) => act(id, action);
    return invoke("huddle_window_open", { view, actions });
  },
  update: (id, view) => invoke("huddle_window_update", { id, view }),
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
        await bridge.open(next, (id, action) => {
          if (disposed || revision !== version || huddles.snapshot().id !== id)
            return;
          if (action === "closed") {
            if (opened !== id) return;
            opened = undefined;
            stopProfiles?.();
            stopProfiles = undefined;
            updates = updates
              .catch(() => {})
              .then(() => bridge.update(id, null));
            void updates.catch(() => {});
            publish(false);
          } else if (action === "mute") huddles.mute();
          else if (action === "leave") void huddles.leave();
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
