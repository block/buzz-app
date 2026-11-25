import type { Connection } from "./client";

const DAY_MS = 86_400_000;
/** How early a connection with a known end asks to be renewed. */
export const EXPIRING_WITHIN_MS = 7 * DAY_MS;

export type ConnectionStatus =
  | { kind: "connected" }
  | { kind: "expiring"; label: string }
  | { kind: "expired" };

export function connectionStatus(
  connection: Connection,
  now: number,
): ConnectionStatus {
  const { expiresAt } = connection;
  if (connection.expired || (expiresAt !== undefined && expiresAt <= now))
    return { kind: "expired" };
  if (expiresAt === undefined || expiresAt - now > EXPIRING_WITHIN_MS)
    return { kind: "connected" };
  const days = Math.floor((expiresAt - now) / DAY_MS);
  return {
    kind: "expiring",
    label:
      days === 0
        ? "Expires today"
        : days === 1
          ? "Expires tomorrow"
          : `Expires in ${days} days`,
  };
}

/** Needs attention first, then by name. */
export function sortConnections(
  connections: readonly Connection[],
  now: number,
): Connection[] {
  const rank = (c: Connection) =>
    ({ expired: 0, expiring: 1, connected: 2 })[connectionStatus(c, now).kind];
  return [...connections].sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
  );
}

/** The service reports only extension names, such as `google-calendar`. */
export function connectionLabel(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** The account's connections page, where a connection signs in again. */
export function connectionsPage(apiRoot: string, name?: string): string {
  const url = new URL("/connections", new URL(apiRoot).origin);
  if (name) url.searchParams.set("connection", name);
  return url.href;
}
