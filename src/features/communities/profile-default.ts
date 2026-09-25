import { communityDestination } from "./destination";
import type { PersonalProfile } from "./service";

/** Community media needs that community's credentials; never seed another one with it. */
export function profileDefault(
  profile: PersonalProfile,
  previous: PersonalProfile,
  community?: string,
): PersonalProfile {
  if (!community || !profile.picture) return profile;
  return profile.picture.startsWith(
    `${communityDestination(community).url}/media/`,
  )
    ? { ...profile, picture: previous.picture }
    : profile;
}
