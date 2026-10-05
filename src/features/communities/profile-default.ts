import { communityDestination } from "./destination";
import type { PersonalProfile } from "./service";

/** Keep current-community media out of the local default used for other communities. */
export function profileDefault(
  profile: PersonalProfile,
  previous: PersonalProfile,
  community?: string,
): PersonalProfile {
  if (!community || !profile.picture) return profile;
  try {
    const picture = new URL(profile.picture);
    return picture.origin === communityDestination(community).url &&
      picture.pathname.startsWith("/media/")
      ? { ...profile, picture: previous.picture }
      : profile;
  } catch {
    return profile;
  }
}
