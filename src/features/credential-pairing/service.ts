// Command-line tools paired with this app through the local credential
// provider. Native code owns pairing; the page approves requests and lists
// and revokes pairings.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { communityDestination } from "../communities/destination";

export type PairRequest = {
  id: string;
  client: string;
  relay: string;
  process: string | null;
  expiresIn: number;
};

export type PairedTool = {
  id: string;
  client: string;
  relay: string;
  /** Unix seconds. */
  created: number;
  lastUsed: number;
  expires: number;
};

export const answerPairing = (id: string, approve: boolean) =>
  invoke<void>("credential_pair_answer", { id, approve });

/** Tells native code the communities saved here, so a tool pairs only for
 * one of them. */
export const setPairingCommunities = (communities: readonly string[]) =>
  invoke<void>("credential_pairing_communities", {
    communities: communities.flatMap((id) => {
      try {
        return [communityDestination(id).url];
      } catch {
        return [];
      }
    }),
  });
export const listPairedTools = () =>
  invoke<PairedTool[]>("credential_pairings_list");

export const revokePairedTool = (id: string) =>
  invoke<void>("credential_pairing_revoke", { id });

/** Calls `on` for each change; returns a function that stops listening. */
export function onPairingEvents(on: {
  request?(request: PairRequest): void;
  closed?(id: string): void;
  changed?(): void;
}) {
  const stops = [
    on.request &&
      listen<PairRequest>("credential-pair-request", (event) =>
        on.request?.(event.payload),
      ),
    on.closed &&
      listen<string>("credential-pair-closed", (event) =>
        on.closed?.(event.payload),
      ),
    on.changed && listen("credential-pairings-changed", () => on.changed?.()),
  ];
  // Without the native event channel there is nothing to approve or list.
  const listening = stops.map((stop) => stop?.catch(() => undefined));
  return () => {
    for (const stop of listening) void stop?.then((unlisten) => unlisten?.());
  };
}
