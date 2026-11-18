import { nativeIdentityEnabled } from "../../features/identity/service";
import { communityFromScope } from "../../features/relay/gifs";
import { nativeRelayInfo } from "../../features/relay/native";

/** NIP-11 `plugin_recording_default`: `on` records members' plugins until
 * they turn it off. Missing or any other value, as on older relays, is off. */
export const recordingDefault = (info: Record<string, unknown>) =>
  info.plugin_recording_default === "on";

/** One NIP-11 read per community. A failed read is dropped and rejects, so
 * the recorder retries it rather than treating the community as off. */
const lookups = new Map<string, Promise<boolean>>();

/** The selected community's default for **Record my plugins in this
 * community**. Off where the host can't read NIP-11. */
export function relayRecordingDefault(scope: string): Promise<boolean> {
  const community = communityFromScope(scope);
  if (!community || !nativeIdentityEnabled()) return Promise.resolve(false);
  let pending = lookups.get(community);
  if (!pending) {
    pending = nativeRelayInfo(community).then(recordingDefault);
    pending.catch(() => lookups.delete(community));
    lookups.set(community, pending);
  }
  return pending;
}
