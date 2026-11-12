import { communityDestination } from "../../features/communities/destination";

/** Whether this build holds channel names to its naming rules in `community`.
 * The build flag lists exact canonical community origins; empty (the default)
 * leaves every community on the plain create flow. */
export function namingRulesApply(community: string | undefined): boolean {
  const listed = (import.meta.env.VITE_BUZZ_CHANNEL_NAMING_COMMUNITIES ?? "")
    .split(" ")
    .filter(Boolean);
  if (!community || !listed.length) return false;
  try {
    return listed.includes(communityDestination(community).url);
  } catch {
    return false;
  }
}

/** The page the create dialog's "Why these rules?" link opens, if the build sets one. */
export function namingGuidelinesUrl(): string | undefined {
  return import.meta.env.VITE_BUZZ_CHANNEL_NAMING_GUIDELINES_URL || undefined;
}
