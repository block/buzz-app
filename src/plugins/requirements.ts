// What a plugin's manifest says it needs from this device before it can run.
// Only the host checks it: a plugin whose need is unmet is not started, and
// Settings says why. The owner's on/off choice is kept either way.
import type { PluginManifest } from "./api";

/** The needs a manifest can declare in `requires`. */
export const PLUGIN_REQUIREMENTS = ["decisions"] as const;
export type PluginRequirement = (typeof PLUGIN_REQUIREMENTS)[number];
export type Availability = Readonly<Record<PluginRequirement, boolean>>;

const REASONS: Record<PluginRequirement, string> = {
  decisions: "Needs a decisions provider",
};

/** Why `manifest` can't run on this device now, or undefined when it can. */
export function unmetRequirement(
  manifest: PluginManifest,
  available: Availability,
): string | undefined {
  const missing = manifest.requires?.find((need) => !available[need]);
  return missing && REASONS[missing];
}
