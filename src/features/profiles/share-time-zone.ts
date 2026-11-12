import { profileFromEvent } from "../communities/api";
import type { PersonalProfile } from "../communities/service";
import { newer, type EventData } from "../relay/events";
import { profileTimeZone } from "./local-time";

export const deviceTimeZone = () =>
  profileTimeZone(new Intl.DateTimeFormat().resolvedOptions().timeZone);

/** `existing` with this device's zone added when the profile has never had a
 * `tz` key; an empty `tz` is an opt-out and stays. */
export function withDeviceTimeZone(
  existing: Record<string, unknown>,
  zone: string | undefined,
): Record<string, unknown> {
  return zone && !("tz" in existing) ? { ...existing, tz: zone } : existing;
}

// Community and viewer pairs already settled this launch.
const settled = new Set<string>();

/** Shares the device zone once per launch per community, after a fresh read
 * of the viewer's own profile. Publishes only into an existing profile that
 * has no `tz` key, and only when the profile writer would leave its other
 * fields as they are, so a background write never renames anyone. Resolves
 * whether it published; a failed read leaves the next fresh read to try. */
export async function shareDeviceTimeZone({
  community,
  viewer,
  read,
  publish,
  signal,
  zone,
}: {
  community: string;
  viewer: string;
  read: Promise<readonly EventData[]>;
  publish(
    profile: PersonalProfile,
    existing: Record<string, unknown>,
  ): Promise<void>;
  signal?: AbortSignal;
  /** This device's zone, from `deviceTimeZone()`. */
  zone: string | undefined;
}): Promise<boolean> {
  const key = `${community}\n${viewer}`;
  if (settled.has(key)) return false;
  let events: readonly EventData[];
  try {
    events = await read;
  } catch {
    return false;
  }
  if (signal?.aborted || settled.has(key)) return false;
  settled.add(key);
  let latest: EventData | undefined;
  for (const event of events)
    if (event.kind === 0 && event.pubkey === viewer)
      latest = newer(latest, event);
  if (!latest || !zone) return false;
  let parsed: ReturnType<typeof profileFromEvent>;
  try {
    parsed = profileFromEvent(latest);
  } catch {
    return false;
  }
  const { existing, profile } = parsed;
  if ("tz" in existing) return false;
  const name = profile.name.trim();
  const written: Record<string, unknown> = {
    name,
    display_name: name,
    picture: profile.picture,
    about: profile.about?.trim() ?? "",
  };
  if (
    !name ||
    Object.entries(written).some(
      ([field, value]) => field in existing && existing[field] !== value,
    )
  )
    return false;
  try {
    await publish(profile, withDeviceTimeZone(existing, zone));
    return true;
  } catch {
    return false;
  }
}

/** Test seam: forget which communities were settled this launch. */
export function resetSharedTimeZones() {
  settled.clear();
}
