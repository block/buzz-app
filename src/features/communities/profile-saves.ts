import type { Communities } from "./service";

// Profile saves per app instance. Settings uses the generation to let only the
// newest save update the local default; background profile writes use it to
// stand aside while a save is running or after one has started.
const generations = new WeakMap<Communities, number>();
const running = new WeakMap<Communities, number>();

export function beginProfileSave(communities: Communities) {
  const generation = profileSaveGeneration(communities) + 1;
  generations.set(communities, generation);
  running.set(communities, (running.get(communities) ?? 0) + 1);
  return generation;
}

export function endProfileSave(communities: Communities) {
  running.set(communities, Math.max(0, (running.get(communities) ?? 0) - 1));
}

export function isCurrentProfileSave(
  communities: Communities,
  generation: number,
) {
  return profileSaveGeneration(communities) === generation;
}

export function profileSaveGeneration(communities: Communities) {
  return generations.get(communities) ?? 0;
}

/** Whether a profile save is running, or one started after `generation`. */
export function profileSavedSince(
  communities: Communities,
  generation: number,
) {
  return (
    profileSaveGeneration(communities) !== generation ||
    (running.get(communities) ?? 0) > 0
  );
}
