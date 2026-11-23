import { invoke, isTauri } from "@tauri-apps/api/core";

const cleared = new Set<(community: string) => void>();

/** Calls `listener` with each community whose TypeSafe key was removed by
 * {@link clearCommunityTypeSafeKey}. Returns the function that stops it. */
export function onCommunityTypeSafeKeyCleared(
  listener: (community: string) => void,
) {
  cleared.add(listener);
  return () => void cleared.delete(listener);
}

/** Removes the TypeSafe key this device saved for `community` (a relay URL),
 * where native code keeps one. */
export async function clearCommunityTypeSafeKey(community: string) {
  if (!isTauri()) return;
  await invoke("jev_classifier_clear_key", { community });
  for (const listener of [...cleared]) listener(community);
}
