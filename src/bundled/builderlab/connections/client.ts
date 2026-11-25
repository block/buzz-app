import { postJson, unexpected } from "../json-request";
import type { BuilderlabSession } from "../session";

/** An account's sign-in to an outside service, keyed by its extension name. */
export type Connection = Readonly<{
  name: string;
  /** When the stored sign-in ends, in epoch milliseconds; unknown for
   * services that renew themselves or report no end. */
  expiresAt?: number;
  /** The service dropped the sign-in: it expired or the provider refused it. */
  expired: boolean;
}>;
type Rejected = ReturnType<typeof unexpected>;
export type ListResult =
  | { kind: "listed"; connections: readonly Connection[] }
  | { kind: "invalid_response" }
  | Rejected;
export type DisconnectResult = { kind: "accepted" } | Rejected;

/** Protobuf JSON spells 64-bit integers as strings. */
function epochSeconds(value: unknown): number | undefined {
  const n =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0
    ? n
    : undefined;
}

/** A listed row, or `undefined` for a shape this client does not understand. */
export function listedConnection(row: unknown): Connection | undefined {
  if (!row || typeof row !== "object") return undefined;
  const { name, expires_at_epoch_s, previously_connected } = row as Record<
    string,
    unknown
  >;
  if (typeof name !== "string" || !name) return undefined;
  const seconds = epochSeconds(expires_at_epoch_s);
  return {
    name,
    ...(seconds ? { expiresAt: seconds * 1000 } : {}),
    expired: previously_connected === true,
  };
}

/** The account's OAuth connections under the signed-in Builderlab session. */
export function createConnectionsClient(session: BuilderlabSession) {
  return {
    async list(signal: AbortSignal): Promise<ListResult> {
      const { status, value } = await postJson(
        session,
        "/list-oauth-extensions",
        {},
        signal,
      );
      if (status !== 200) return unexpected(status);
      if (!value) return { kind: "invalid_response" };
      // Protobuf JSON can omit an empty repeated field.
      const rows = value.extensions ?? [];
      if (!Array.isArray(rows)) return { kind: "invalid_response" };
      const connections = rows.map(listedConnection);
      return connections.every((c) => c !== undefined)
        ? { kind: "listed", connections }
        : { kind: "invalid_response" };
    },
    async disconnect(
      name: string,
      signal: AbortSignal,
    ): Promise<DisconnectResult> {
      const { status } = await postJson(
        session,
        "/delete-oauth-extension",
        { extension: name },
        signal,
      );
      return status === 200 ? { kind: "accepted" } : unexpected(status);
    },
  };
}
export type ConnectionsClient = ReturnType<typeof createConnectionsClient>;
