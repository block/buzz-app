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

export type SignRequest = {
  id: string;
  /** The paired tool's id, as listed by `listPairedTools`. */
  pairing: string;
  client: string;
  relay: string;
  kind: number;
  tags: string[][];
  expiresIn: number;
  /** How long "window" lets the same tool sign the same kind unasked. */
  windowSeconds: number;
};

export type SignAnswer = "deny" | "once" | "window";

/** A remembered approval: the tool signs this kind unasked until `until`. */
export type SignWindow = {
  kind: number;
  /** Unix seconds. */
  until: number;
};

export type PairedTool = {
  id: string;
  client: string;
  relay: string;
  /** Unix seconds. */
  created: number;
  lastUsed: number;
  expires: number;
  /** Unexpired remembered approvals. */
  windows: SignWindow[];
};

export const answerPairing = (id: string, approve: boolean) =>
  invoke<void>("credential_pair_answer", { id, approve });

/** Tells native code the communities saved here, so a tool pairs only for
 * one of them, and the one open, for a tool that names none. */
export const setPairingCommunities = (
  communities: readonly string[],
  active: string | null,
) =>
  invoke<void>("credential_pairing_communities", {
    communities: communities.flatMap((id) => {
      const url = destinationUrl(id);
      return url ? [url] : [];
    }),
    active: active && destinationUrl(active),
  });

const destinationUrl = (id: string) => {
  try {
    return communityDestination(id).url;
  } catch {
    return null;
  }
};
/** Tells native a prompt began or stopped listening; while none listens,
 * native refuses pairing at once instead of asking nobody. */
export const setPairingPrompt = (mounted: boolean) =>
  invoke<void>("credential_pair_prompt", { mounted });

export const answerSigning = (id: string, answer: SignAnswer) =>
  invoke<void>("credential_sign_answer", { id, answer });

/** Tells native a signing prompt began or stopped listening; while none
 * listens, native refuses a sensitive kind at once instead of asking nobody. */
export const setSigningPrompt = (mounted: boolean) =>
  invoke<void>("credential_sign_prompt", { mounted });

export const stopSigningWindow = (pairing: string, kind: number) =>
  invoke<void>("credential_sign_window_stop", { id: pairing, kind });

export const listPairedTools = () =>
  invoke<PairedTool[]>("credential_pairings_list");

export const revokePairedTool = (id: string) =>
  invoke<void>("credential_pairing_revoke", { id });

/** Calls `on` for each change, and `ready` once every listener is in place;
 * returns a function that stops listening. */
export function onPairingEvents(on: {
  request?(request: PairRequest): void;
  closed?(id: string): void;
  signRequest?(request: SignRequest): void;
  signClosed?(id: string): void;
  changed?(): void;
  ready?(): void;
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
    on.signRequest &&
      listen<SignRequest>("credential-sign-request", (event) =>
        on.signRequest?.(event.payload),
      ),
    on.signClosed &&
      listen<string>("credential-sign-closed", (event) =>
        on.signClosed?.(event.payload),
      ),
    on.changed && listen("credential-pairings-changed", () => on.changed?.()),
  ];
  // Without the native event channel there is nothing to approve or list.
  const listening = stops.map((stop) => stop?.catch(() => undefined));
  void Promise.all(stops).then(
    () => on.ready?.(),
    () => undefined,
  );
  return () => {
    for (const stop of listening) void stop?.then((unlisten) => unlisten?.());
  };
}
