import { npubEncode, decode } from "nostr-tools/nip19";

/** Public identity locator, not a relay hint or an authority claim. */
export function profileTarget(
  pubkey: string,
  hint?: { agent: boolean },
): string | undefined {
  return /^[a-f0-9]{64}$/i.test(pubkey)
    ? hint?.agent
      ? `buzz:agent-profile:${pubkey.toLowerCase()}`
      : `nostr:${npubEncode(pubkey.toLowerCase())}`
    : undefined;
}

/** App-local avatar presentation only; never evidence of ownership or control. */
export function profileAgentHint(target: string): boolean {
  return /^buzz:agent-profile:[a-f0-9]{64}$/.test(target);
}

export function profilePanelKey(target: string): string | undefined {
  return profileAgentHint(target)
    ? target.slice("buzz:agent-profile:".length)
    : profileKey(target);
}

/** Public message/composer input must never supply an app-local avatar hint. */
export function profileKey(target: string): string | undefined {
  if (!/^nostr:npub1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(target))
    return undefined;
  try {
    const decoded = decode(target.slice(6));
    return decoded.type === "npub" ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}

/** App-local Activity destination, never a public identity or authority claim.
 * `transcript` is for an opener that knows which one conversation the work is
 * in: Activity then shows that conversation's transcript first. */
export function profileActivityViewTarget(
  pubkey: string,
  options?: { transcript: boolean },
): string | undefined {
  return profileTarget(pubkey)
    ? `buzz:profile?agent=${pubkey.toLowerCase()}&tab=activity${options?.transcript ? "&open=transcript" : ""}`
    : undefined;
}
export function profileActivityViewKey(target: string): string | undefined {
  try {
    const agent = new URL(target).searchParams.get("agent");
    return agent &&
      (target === profileActivityViewTarget(agent) ||
        target === profileActivityViewTarget(agent, { transcript: true }))
      ? agent
      : undefined;
  } catch {
    return undefined;
  }
}
/** Transcript destinations an opener has just opened, not yet shown. */
const transcriptRequests = new Set<string>();
const transcriptListeners = new Set<() => void>();
const changed = () => {
  for (const listener of transcriptListeners) listener();
};
export function subscribeProfileTranscripts(listener: () => void) {
  transcriptListeners.add(listener);
  return () => void transcriptListeners.delete(listener);
}
/** Opens `target` through `open`, asking the profile it opens to show its
 * transcript once. A target that is only shown again, as when its retained
 * tab remounts on returning to the channel, asks for nothing. */
export function openProfileTranscript(
  target: string,
  open: (target: string) => boolean,
): boolean {
  if (!profileActivityTranscript(target)) return open(target);
  transcriptRequests.add(target);
  const opened = open(target);
  if (!opened) transcriptRequests.delete(target);
  changed();
  return opened;
}
/** Whether an opener still asks `target`'s profile for its transcript. */
export function profileTranscriptRequested(target: string): boolean {
  return transcriptRequests.has(target);
}
/** The request has been offered; opening the target again asks anew. */
export function settleProfileTranscript(target: string): void {
  if (transcriptRequests.delete(target)) changed();
}
/** Whether an Activity destination asks for its conversation's transcript. */
export function profileActivityTranscript(target: string): boolean {
  const agent = profileActivityViewKey(target);
  return (
    !!agent && target === profileActivityViewTarget(agent, { transcript: true })
  );
}
