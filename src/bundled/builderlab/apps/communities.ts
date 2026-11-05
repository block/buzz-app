import { relayAddress } from "../../../features/communities/destination";
import type { BuilderlabSession } from "../session";
import { SIGN_IN } from "./client";

/** A Buzz community the signed-in account has joined, which an app can be
 * shared with. `address` is in the device's spelling (`relayAddress`). */
export type JoinedCommunity = Readonly<{
  id: string;
  name: string;
  address: string;
}>;

const address = (host: unknown) => {
  if (typeof host !== "string" || !host.trim()) return undefined;
  try {
    return relayAddress(`wss://${host.trim().replace(/^wss?:\/\//, "")}`);
  } catch {
    return undefined;
  }
};

/** The communities Builderlab knows the account's Buzz key has joined. Rows
 * without a usable ID or address are left out. */
export async function joinedCommunities(
  session: BuilderlabSession,
): Promise<JoinedCommunity[]> {
  if (session.snapshot().status !== "signed-in")
    throw new Error(`Builderlab is not signed in. ${SIGN_IN}`);
  const credential = session.credential();
  const response = await session.request(credential, {
    path: "/v1/buzz/joined-communities/list",
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (response.status === 401) session.expired(credential);
  if (response.status < 200 || response.status >= 300)
    throw new Error(
      `Couldn’t load your communities (HTTP ${response.status}).`,
    );
  let rows: unknown;
  try {
    rows = (JSON.parse(response.body) as { communities?: unknown }).communities;
  } catch {
    throw new Error("Builderlab returned an invalid community list.");
  }
  if (!Array.isArray(rows))
    throw new Error("Builderlab returned an invalid community list.");
  return rows.flatMap((row: Record<string, unknown> | null) => {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    const where = address(row?.normalized_host ?? row?.normalizedHost);
    if (!id || !where) return [];
    const name =
      typeof row?.name === "string" && row.name.trim()
        ? row.name.trim()
        : new URL(where).host;
    return [{ id, name, address: where }];
  });
}
