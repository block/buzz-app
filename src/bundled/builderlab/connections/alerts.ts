import type { OpenTarget } from "../../../features/navigation/targets";
import type { NotificationInput } from "../../../features/notifications/service";
import { connectionLabel, connectionStatus } from "./status";
import type { ConnectionsStore } from "./store";

const SHOWN_KEY = "builderlab:connection-alerts";
export const RECHECK_MS = 60 * 60 * 1000;

function readShown(storage: Storage): Set<string> {
  try {
    const value: unknown = JSON.parse(storage.getItem(SHOWN_KEY) ?? "[]");
    return new Set(
      Array.isArray(value)
        ? value.filter((v): v is string => typeof v === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

/** Alerts once per connection as it nears its end and once when it ends,
 * across restarts. Re-reads hourly while the app runs. */
export function startConnectionAlerts({
  store,
  submit,
  target,
  storage = localStorage,
  now = Date.now,
}: {
  store: Pick<ConnectionsStore, "snapshot" | "subscribe" | "refresh">;
  submit(input: NotificationInput): Promise<boolean>;
  target: OpenTarget;
  storage?: Storage;
  now?: () => number;
}) {
  const check = () => {
    const { connections } = store.snapshot();
    if (!connections) return;
    const shown = readShown(storage);
    const current = new Set<string>();
    const at = now();
    for (const connection of connections) {
      const status = connectionStatus(connection, at);
      if (status.kind === "connected") continue;
      const sourceKey = `${connection.name}:${status.kind}:${connection.expiresAt ?? ""}`;
      current.add(sourceKey);
      if (shown.has(sourceKey)) continue;
      const name = connectionLabel(connection.name);
      void submit({
        sourceKey,
        target,
        title:
          status.kind === "expired"
            ? `${name} connection expired`
            : `${name} connection ${status.label.toLowerCase()}`,
        body: "Reconnect it so your agents can keep using it.",
      });
    }
    try {
      storage.setItem(SHOWN_KEY, JSON.stringify([...current]));
    } catch {
      /* Storage full or unavailable: alerts may repeat next launch. */
    }
  };
  const stop = store.subscribe(check);
  check();
  const timer = setInterval(() => void store.refresh(), RECHECK_MS);
  return () => {
    clearInterval(timer);
    stop();
  };
}
