import { profileFromEvent } from "../communities/api";
import {
  profileSaveGeneration,
  profileSavedSince,
} from "../communities/profile-saves";
import type { Communities, PersonalProfile } from "../communities/service";
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

type ProfileRead = ReturnType<typeof profileFromEvent>;

/** Whether a background write may add `tz`: the profile exists, has no `tz`
 * key, and the profile writer would leave its other fields as they are. */
function shareable({ exists, existing, profile }: ProfileRead) {
  if (!exists || "tz" in existing) return false;
  const name = profile.name.trim();
  const written: Record<string, unknown> = {
    name,
    display_name: name,
    picture: profile.picture,
    about: profile.about?.trim() ?? "",
  };
  return (
    !!name &&
    !Object.entries(written).some(
      ([field, value]) => field in existing && existing[field] !== value,
    )
  );
}

/** Shares the device zone once per launch per community. A fresh read of the
 * viewer's own profile triggers it; a strong read just before publishing is
 * what gets published, so a lagging read never reverts a newer profile.
 * Publishes only into an existing profile that has no `tz` key, only when the
 * profile writer would leave its other fields as they are (so a background
 * write never renames anyone), and never while a profile save is running or
 * after one started. Resolves whether it published; a failed read leaves the
 * next fresh read to try. */
export async function shareDeviceTimeZone({
  community,
  viewer,
  communities,
  read,
  inspect,
  publish,
  signal,
  zone,
}: {
  community: string;
  viewer: string;
  /** The app's communities, whose profile saves this write stands aside for. */
  communities: Communities;
  /** The fresh background read that triggers the share. */
  read: Promise<readonly EventData[]>;
  /** A strong read of the viewer's profile, as `inspectProfile` returns. */
  inspect(): Promise<ProfileRead>;
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
  const saves = profileSaveGeneration(communities);
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
  try {
    if (!shareable(profileFromEvent(latest))) return false;
  } catch {
    return false;
  }
  let current: ProfileRead;
  try {
    current = await inspect();
  } catch {
    settled.delete(key);
    return false;
  }
  if (signal?.aborted) {
    settled.delete(key);
    return false;
  }
  if (!shareable(current) || profileSavedSince(communities, saves))
    return false;
  try {
    await publish(current.profile, withDeviceTimeZone(current.existing, zone));
    return true;
  } catch {
    return false;
  }
}

/** Test seam: forget which communities were settled this launch. */
export function resetSharedTimeZones() {
  settled.clear();
}
