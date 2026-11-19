import type { RelaySession } from "../../features/relay/session";
import { searchedProfiles } from "../../features/relay/profile-search";

/** Resolve only an unambiguous verified community username. */
export async function resolveProviderProfile(
  session: RelaySession,
  username: string,
  signal: AbortSignal,
): Promise<string> {
  const events = await session.searchProfiles(username, {
    limit: 100,
    signal: signal,
  });
  signal.throwIfAborted();
  const candidates = searchedProfiles(
    events,
    session.profiles.verifiedAuthority?.(),
  );
  const verified = await session.directMessages.verified(
    [...candidates.keys()],
    signal,
  );
  signal.throwIfAborted();
  const matches = [...(verified?.profiles ?? [])].filter(
    ([, profile]) =>
      profile.status === "checked" && profile.username === username,
  );
  const match = matches[0];
  if (matches.length !== 1 || !match)
    throw new Error("No profile in this community");
  return match[0];
}
