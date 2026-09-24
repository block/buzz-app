export type PresencePreference = "auto" | "away" | "offline";
const preference = (value: unknown): PresencePreference =>
  value === "away" || value === "offline" ? value : "auto";

/** One app input/preference source shared by retained community publishers. */
export function createPresenceActivity() {
  const listeners = new Set<() => void>();
  let last = Date.now(),
    sharedAt = 0;
  let away = false;
  let viewer: string | undefined;
  let choice: PresencePreference = "auto";
  let error: string | undefined;
  const status = (): "online" | "away" | "offline" =>
    choice === "auto" ? (away ? "away" : "online") : choice;
  let snapshot: {
    status: ReturnType<typeof status>;
    preference: PresencePreference;
    error: string | undefined;
  } = { status: status(), preference: choice, error };
  const emit = () => {
    snapshot = { status: status(), preference: choice, error };
    for (const listener of listeners) listener();
  };
  const storageKey = () => `buzz-presence.v1:${viewer}`;
  const restore = () => {
    try {
      choice = preference(localStorage.getItem(storageKey()));
      error = undefined;
    } catch {
      error = "Could not read your saved status. Changes apply to this window.";
    }
    emit();
  };
  const stored = (event: StorageEvent) => {
    if (viewer && (event.key === null || event.key === storageKey())) restore();
  };
  const visible = () =>
    typeof document !== "undefined" && document.visibilityState === "visible";
  let shown = visible();
  const channel =
    typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel("buzz-presence-input")
      : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function update() {
    clearTimeout(timer);
    const nextAway = Date.now() - last >= 600000;
    const nextShown = visible();
    if (nextAway !== away || nextShown !== shown) {
      away = nextAway;
      shown = nextShown;
      emit();
    }
    if (!away)
      timer = setTimeout(update, Math.max(1, last + 600000 - Date.now()));
  }
  const input = () => {
    last = Date.now();
    if (last - sharedAt >= 1000) {
      sharedAt = last;
      channel?.postMessage(last);
    }
    update();
  };
  if (channel)
    channel.onmessage = ({ data }) => {
      if (
        typeof data === "number" &&
        Number.isFinite(data) &&
        data > last &&
        data <= Date.now()
      ) {
        last = data;
        update();
      }
    };
  const activate = () => {
    if (visible()) input();
    else update();
  };
  const events = [
    "pointerdown",
    "pointermove",
    "keydown",
    "wheel",
    "touchstart",
    "input",
  ];
  if (typeof document !== "undefined") {
    // Editors and menus may stop bubbling. Activity is observation, not a
    // shortcut: capture it before a control handles the event.
    for (const event of events)
      document.addEventListener(event, input, { passive: true, capture: true });
    document.addEventListener("visibilitychange", activate);
    update();
  }
  if (typeof window !== "undefined") {
    window.addEventListener("focus", activate);
    window.addEventListener("storage", stored);
  }
  return {
    status,
    snapshot: () => snapshot,
    setViewer(value: string) {
      if (value === viewer) return;
      viewer = value;
      choice = "auto";
      restore();
    },
    setPreference(value: PresencePreference) {
      if (!viewer) return;
      choice = preference(value);
      try {
        localStorage.setItem(storageKey(), choice);
        error = undefined;
      } catch {
        error =
          "Could not save your status. It applies to this window until you close it.";
      }
      if (choice === "auto") input();
      emit();
    },
    visible: () => shown,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      clearTimeout(timer);
      channel?.close();
      listeners.clear();
      if (typeof document !== "undefined") {
        for (const event of events)
          document.removeEventListener(event, input, true);
        document.removeEventListener("visibilitychange", activate);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", activate);
        window.removeEventListener("storage", stored);
      }
    },
  };
}
export type PresenceActivity = Pick<
  ReturnType<typeof createPresenceActivity>,
  "status" | "visible" | "subscribe" | "dispose"
>;
