import { invoke, isTauri } from "@tauri-apps/api/core";

/** Removes the TypeSafe key this device saved for `community` (a relay URL),
 * where native code keeps one. */
export async function clearCommunityTypeSafeKey(community: string) {
  if (!isTauri()) return;
  await invoke("jev_classifier_clear_key", { community });
}
