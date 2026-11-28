import type { ScenePublish, SceneEvent, SceneRead } from "./store";

/** A relay's part in one canvas: the current revision, `prev` checking and
 * live delivery. For tests and the browser fixture. */
export function memoryCanvasRelay() {
  let head: SceneEvent | undefined;
  let count = 0;
  const listeners = new Set<(events: readonly SceneEvent[]) => void>();
  const read: SceneRead = async () => (head ? [head] : []);
  const publish: ScenePublish = async (template) => {
    const prev = template.tags.find(([name]) => name === "prev")?.[1];
    if (prev !== head?.id) throw new Error("conflict: stale prev");
    const event = {
      ...template,
      id: (++count).toString(16).padStart(64, "0"),
    };
    head = event;
    for (const listener of [...listeners]) listener([event]);
    return event;
  };
  return {
    read,
    publish,
    follow(listener: (events: readonly SceneEvent[]) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    head: () => head,
  };
}
