// Voice jump: a shortcut opens a box that listens through the speech
// service, and what was said picks a place to go among the conversations
// this device already holds. The speech provider the person chose in
// Settings transcribes; the decision provider picks the place.
import { lazy, Suspense, useRef, useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";
import { activeModal } from "../../shared/design-system/overlayLayer";

// Loaded on first open, so the plugin list doesn't pull the dialog into
// every page that imports it.
const VoiceJumpDialog = lazy(() =>
  import("./VoiceJumpDialog").then((m) => ({ default: m.VoiceJumpDialog })),
);

export const inject = [
  "pages",
  "relay",
  "navigation",
  "shortcuts",
  "speech",
  "decisions",
];

export const apply: PluginModule["apply"] = (ctx) => {
  const listeners = new Set<() => void>();
  let open = false;
  const set = (next: boolean) => {
    if (next === open) return;
    open = next;
    for (const listener of listeners) listener();
  };
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    snapshot: () => open,
  };
  // The shortcut pressed while the box is open stops or restarts listening.
  const again: { current: (() => void) | undefined } = { current: undefined };

  // The first opening starts with the recognizer warm.
  ctx.speech.prepare();

  // A modal on its way out, such as this box just after Escape, doesn't count.
  const available = () => {
    const modal = activeModal(document);
    return open || !modal || modal.hasAttribute("data-closed");
  };
  ctx.shortcuts.register({
    id: "open",
    title: "Jump by voice",
    binding: { key: "k", mod: true, shift: true },
    order: 12,
    allowInEditable: true,
    allowInModal: true,
    when: available,
    run: () => (again.current ? again.current() : set(true)),
  });

  ctx.pages.registerOverlay({
    id: "voice-jump",
    component: function VoiceJump() {
      const isOpen = useSyncExternalStore(store.subscribe, store.snapshot);
      const relay = useSyncExternalStore(
        ctx.relay.subscribe,
        ctx.relay.snapshot,
      );
      const opened = useRef(false);
      if (isOpen) opened.current = true;
      if (!opened.current) return null;
      return (
        <Suspense fallback={null}>
          <VoiceJumpDialog
            open={isOpen}
            onOpenChange={(next) => {
              set(next);
              // The next opening starts with the recognizer warm again.
              if (!next) ctx.speech.prepare();
            }}
            speech={ctx.speech}
            decisions={ctx.decisions}
            session={relay.session}
            scope={
              relay.viewer && relay.origin
                ? { viewer: relay.viewer, communityOrigin: relay.origin }
                : undefined
            }
            navigate={(target) => void ctx.navigation.open(target)}
            again={again}
          />
        </Suspense>
      );
    },
  });
};
