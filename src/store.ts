import {
  EMPTY_SCENE,
  parseScene,
  serializeScene,
  type CanvasScene,
} from "./scene";
import type { CanvasViews } from "./view";

/** A scene is one NIP-AR artifact in its channel, so the relay already owns
 * who may read and write it, its revisions and its live delivery. */
export const CANVAS_KIND = 45010;
export const CANVAS_TYPE = "buzz.canvas";

export type SceneEvent = Readonly<{
  id: string;
  kind: number;
  content: string;
  tags: readonly (readonly string[])[];
}>;
export type SceneTemplate = { kind: number; content: string; tags: string[][] };
export type SceneRead = (
  filters: readonly Record<string, unknown>[],
  signal?: AbortSignal,
) => Promise<readonly SceneEvent[]>;
export type ScenePublish = (
  template: SceneTemplate,
  signal?: AbortSignal,
) => Promise<{ id: string }>;
/** A scene and the relay revision it came from; none before the first save. */
export type SavedScene = Readonly<{ scene: CanvasScene; revision?: string }>;

const tag = (event: SceneEvent, name: string) =>
  event.tags.find((entry) => entry[0] === name)?.[1];
/** True for a revision of `channelId`'s canvas. */
export const isSceneEvent = (event: SceneEvent, channelId: string) =>
  event.kind === CANVAS_KIND &&
  tag(event, "type") === CANVAS_TYPE &&
  tag(event, "d") === channelId &&
  tag(event, "h") === channelId;

/** The relay's current revision. Never pick the newest timestamp locally. */
export async function readScene(
  read: SceneRead,
  channelId: string,
  views: Pick<CanvasViews, "get">,
  signal?: AbortSignal,
): Promise<SavedScene> {
  const events = await read(
    [
      {
        kinds: [CANVAS_KIND],
        "#h": [channelId],
        "#d": [channelId],
        limit: 1,
        consistency: "strong",
      },
    ],
    signal,
  );
  signal?.throwIfAborted();
  const event = events.find((entry) => isSceneEvent(entry, channelId));
  if (!event) return { scene: EMPTY_SCENE };
  // An unreadable or cleared revision still has to be named as `prev`.
  return {
    scene:
      tag(event, "op") === "delete"
        ? EMPTY_SCENE
        : (parseScene(event.content, views) ?? EMPTY_SCENE),
    revision: event.id,
  };
}

export class SceneConflict extends Error {
  constructor() {
    super("The canvas changed while you were changing it.");
  }
}

export async function saveScene(
  publish: ScenePublish,
  channelId: string,
  base: SavedScene,
  scene: CanvasScene,
  signal?: AbortSignal,
): Promise<SavedScene> {
  const template = {
    kind: CANVAS_KIND,
    content: serializeScene(scene),
    tags: [
      ["ar", "1"],
      ["d", channelId],
      ["h", channelId],
      ["type", CANVAS_TYPE],
      ["title", "Canvas"],
      ["op", base.revision ? "update" : "create"],
      ...(base.revision ? [["prev", base.revision]] : []),
    ],
  };
  try {
    return { scene, revision: (await publish(template, signal)).id };
  } catch (error) {
    if (error instanceof Error && /\bconflict:|duplicate/i.test(error.message))
      throw new SceneConflict();
    throw error;
  }
}

export type CanvasSnapshot = Readonly<{
  status: "loading" | "ready" | "error";
  scene: CanvasScene;
  /** Why the last read or save failed. The scene shown is the relay's. */
  error?: string;
}>;
/** One channel's live canvas. */
export type CanvasChannel = {
  snapshot(): CanvasSnapshot;
  subscribe(listener: () => void): () => void;
  /** Applies `update` to the current scene and saves it. Shown at once, and
   * redone on the relay's latest scene if someone else saved first. */
  change(update: (scene: CanvasScene) => CanvasScene): Promise<void>;
  dispose(): void;
};

export function createCanvasChannel(options: {
  channelId: string;
  views: Pick<CanvasViews, "get">;
  read: SceneRead;
  publish: ScenePublish;
  /** Calls back with this channel's new artifact revisions; returns a stop. */
  follow(listener: (events: readonly SceneEvent[]) => void): () => void;
}): CanvasChannel {
  const { channelId, views, read, publish } = options;
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  let saved: SavedScene = { scene: EMPTY_SCENE };
  let current: CanvasSnapshot = { status: "loading", scene: EMPTY_SCENE };
  let work: Promise<unknown> = Promise.resolve();
  const set = (next: CanvasSnapshot) => {
    current = next;
    for (const listener of listeners) listener();
  };
  const message = (error: unknown) =>
    error instanceof Error ? error.message : "The canvas is unavailable.";
  const refresh = async () => {
    saved = await readScene(read, channelId, views, lifetime.signal);
    set({ status: "ready", scene: saved.scene });
  };
  /** Reads and saves run one at a time, so each save names the right `prev`. */
  const enqueue = <T>(task: () => Promise<T>) => {
    const run = work.then(task);
    work = run.catch(() => {});
    return run;
  };
  const reload = () =>
    enqueue(refresh).catch((error) => {
      if (!lifetime.signal.aborted)
        set({ ...current, status: "error", error: message(error) });
    });
  const stop = options.follow((events) => {
    if (
      events.some(
        (event) =>
          isSceneEvent(event, channelId) && event.id !== saved.revision,
      )
    )
      void reload();
  });
  void reload();
  return {
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    change: (update) =>
      enqueue(async () => {
        for (let attempt = 0; ; attempt++) {
          const scene = update(saved.scene);
          if (scene === saved.scene) return;
          set({ status: "ready", scene });
          try {
            saved = await saveScene(
              publish,
              channelId,
              saved,
              scene,
              lifetime.signal,
            );
            return;
          } catch (error) {
            if (lifetime.signal.aborted) throw error;
            await refresh().catch(() => {});
            if (error instanceof SceneConflict && attempt === 0) continue;
            set({ ...current, error: message(error) });
            throw error;
          }
        }
      }),
    dispose() {
      lifetime.abort();
      stop();
      listeners.clear();
    },
  };
}
