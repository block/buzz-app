import { useCallback, useSyncExternalStore } from "react";
import { useAgentChoices } from "../agents/use-choices";
import type { MentionRecipient } from "../messages/mention-draft";
import type { RelaySession } from "../relay/session";
import { readView, subscribeView, writeView } from "../../shared/view-state";

// Saved on this device for the account and community (the view scope).
const KEY = "solo:default-agent";

const PUBKEY = /^[0-9a-f]{64}$/;

/** Sets or clears the explicit Bestie/default used for new chats. */
export function setDefaultAgent(scope: string, pubkey: string | null) {
  return writeView(
    scope,
    KEY,
    pubkey !== null && PUBKEY.test(pubkey) ? pubkey : null,
  );
}

/**
 * The agent explicitly chosen on this device, with no stand-in: nothing writes
 * this but a person choosing or removing one. Read
 * `useDefaultAgent` instead to learn which agent a message would be tagged for.
 */
export function readDefaultAgent(scope: string) {
  const value = readView<unknown>(scope, KEY, null);
  return typeof value === "string" && PUBKEY.test(value) ? value : undefined;
}

export function useChosenAgent(scope: string) {
  return useSyncExternalStore(
    useCallback((notify: () => void) => subscribeView(scope, notify), [scope]),
    () => readDefaultAgent(scope),
  );
}

/**
 * The agent new Berd messages are tagged for: the one chosen as default when
 * it can still be tagged, otherwise the first agent the viewer runs here, else
 * the first agent they can tag. Bestie shares the explicit choice, not this fallback. A requested
 * agent, as when search opens a new chat with it, replaces that choice: it is
 * tagged once it can be, and no other agent stands in for it.
 */
export function useDefaultAgent(
  session: RelaySession,
  scope: string,
  requested?: string,
): MentionRecipient | undefined {
  const chosen = useChosenAgent(scope);
  // The same evidence the Berd composer's mention roster reads.
  const choices = useAgentChoices(session, true, true);
  const fallbackReady =
    !requested &&
    choices.complete &&
    choices.archives.status !== "idle" &&
    choices.archives.status !== "loading";
  const agent =
    choices.selectable.find(
      (choice) => choice.pubkey === (requested ?? chosen),
    ) ??
    (fallbackReady
      ? (choices.selectable.find((choice) => choice.managed) ??
        choices.selectable[0])
      : undefined);
  return agent
    ? { pubkey: agent.pubkey, name: agent.managedName ?? agent.name }
    : undefined;
}
