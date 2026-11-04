import type {
  ReadingHandle,
  UnreadCapability,
} from "../../features/relay/unread";
import type { ReadingMessage } from "../../features/popout/window";

/** A companion's reading surface: `useReading` measures geometry, focus and
 * dwell here; every lease lives in the main window, which validates ids
 * against this window's projection and publishes intent. A disposed lease
 * answers no later observation, so delayed messages cannot revive cancelled
 * reading intent. */
export function createReadingProxy(
  send: (message: ReadingMessage) => void,
  enabled: () => boolean,
): Pick<UnreadCapability, "reading" | "sync"> {
  return {
    sync: () => ({
      capability: enabled() ? "frontier-sync" : "unsupported",
      status: "local",
      completeness: "unknown",
    }),
    reading(_channelId): ReadingHandle {
      const lease = crypto.randomUUID();
      let disposed = false;
      send({ op: "acquire", lease });
      return {
        view(ids) {
          if (!disposed) send({ op: "view", lease, ids: [...ids] });
        },
        async observe(ids) {
          if (!disposed) send({ op: "observe", lease, ids: [...ids] });
        },
        async catchUp(id) {
          if (!disposed) send({ op: "catchUp", lease, id });
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          send({ op: "dispose", lease });
        },
      };
    },
  };
}
