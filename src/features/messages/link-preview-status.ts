import type { Contribution } from "../../plugins/contributions";
import type {
  ContributionReader,
  LinkPreviewRenderer,
  LinkPreviewStatus,
} from "../conversation/contracts";

type StatusStore = Readonly<{
  get(): LinkPreviewStatus;
  subscribe(listener: () => void): () => void;
}>;

const ready: StatusStore = Object.freeze({
  get: () => "ready" as const,
  subscribe: () => () => {},
});

const stores = new WeakMap<Contribution<LinkPreviewRenderer>, StatusStore>();

function read(entry: Contribution<LinkPreviewRenderer>): LinkPreviewStatus {
  try {
    const status = entry.status?.();
    return status === "checking" || status === "needs-setup" ? status : "ready";
  } catch {
    return "ready";
  }
}

/** One store per registration, shared by every card it draws, so a renderer
 * is asked once rather than once per link. A registration that has left the
 * registry keeps its last answer and is no longer asked or listened to. */
export function linkPreviewStatus(
  registry: ContributionReader<LinkPreviewRenderer>,
  entry: Contribution<LinkPreviewRenderer>,
): StatusStore {
  if (!entry.status || !entry.subscribe) return ready;
  const known = stores.get(entry);
  if (known) return known;
  const listeners = new Set<() => void>();
  const installed = () => registry.snapshot().includes(entry);
  let current: LinkPreviewStatus | undefined;
  let stop: (() => void) | undefined;
  const refresh = () => {
    if (!installed()) return;
    const next = read(entry);
    if (next === current) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };
  const store: StatusStore = Object.freeze({
    get() {
      if (current === undefined) current = installed() ? read(entry) : "ready";
      return current;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!stop) {
        let live = true;
        let unsubscribe: (() => void) | undefined;
        try {
          const result = entry.subscribe?.(() => {
            if (live) refresh();
          });
          if (typeof result === "function") unsubscribe = result;
        } catch {
          unsubscribe = undefined;
        }
        stop = () => {
          live = false;
          try {
            unsubscribe?.();
          } catch {
            // A provider's unsubscribe failing must not break unmounting.
          }
        };
        refresh();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size || !stop) return;
        stop();
        stop = undefined;
        current = undefined;
      };
    },
  });
  stores.set(entry, store);
  return store;
}
