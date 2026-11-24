import type { CanvasViews } from "./view";

/** One view on the canvas. `state` belongs to the view type named by `type`. */
export type CanvasItem = Readonly<{
  id: string;
  type: string;
  title?: string;
  state: unknown;
}>;
/** What a channel's canvas shows. Everyone following sees this. */
export type CanvasScene = Readonly<{
  items: readonly CanvasItem[];
  /** The item in front. */
  active?: string;
  /** Who holds the wheel. Presentation only: the relay decides who may write. */
  driver?: string;
}>;

export const EMPTY_SCENE: CanvasScene = Object.freeze({ items: [] });
export const MAX_ITEMS = 12;
/** Leaves room in the relay's 64 KiB frame for tags and the signature. */
export const MAX_SCENE_BYTES = 48_000;

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TYPE = /^[a-z][a-z0-9-]{0,31}$/;
const PUBKEY = /^[0-9a-f]{64}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Reads a saved scene. An item of a type this app knows is kept only if its
 * view accepts the state; one of an unknown type is kept as it is, so a viewer
 * without that plugin doesn't erase it for everyone else on the next save. */
export function parseScene(
  text: string,
  views: Pick<CanvasViews, "get">,
): CanvasScene | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return;
  }
  if (!record(value) || value.version !== 1 || !Array.isArray(value.items))
    return;
  const items: CanvasItem[] = [];
  for (const entry of value.items.slice(0, MAX_ITEMS)) {
    if (
      !record(entry) ||
      typeof entry.id !== "string" ||
      !ID.test(entry.id) ||
      typeof entry.type !== "string" ||
      !TYPE.test(entry.type) ||
      items.some((item) => item.id === entry.id)
    )
      continue;
    const view = views.get(entry.type);
    const state = view ? view.parse(entry.state) : entry.state;
    if (state === undefined) continue;
    items.push({
      id: entry.id,
      type: entry.type,
      ...(typeof entry.title === "string" && entry.title.trim()
        ? { title: entry.title.trim().slice(0, 80) }
        : {}),
      state,
    });
  }
  const active = items.find((item) => item.id === value.active) ?? items[0];
  return {
    items,
    ...(active ? { active: active.id } : {}),
    ...(typeof value.driver === "string" && PUBKEY.test(value.driver)
      ? { driver: value.driver }
      : {}),
  };
}

export function serializeScene(scene: CanvasScene) {
  const text = JSON.stringify({ version: 1, ...scene });
  if (new TextEncoder().encode(text).length > MAX_SCENE_BYTES)
    throw new Error("This canvas holds too much to save. Close a view first.");
  return text;
}

/** Adds a view, or replaces the one with that id, and brings it to the front. */
export function openItem(
  scene: CanvasScene,
  views: Pick<CanvasViews, "get">,
  input: { id?: string; type: string; title?: string; state: unknown },
): CanvasScene {
  const view = views.get(input.type);
  if (!view) throw new Error(`There is no "${input.type}" canvas view.`);
  const state = view.parse(input.state);
  if (state === undefined)
    throw new Error(`That is not a valid state for a ${input.type} view.`);
  const id = input.id ?? nextId(scene, input.type);
  if (!ID.test(id))
    throw new Error(
      "A view id is lowercase letters, digits, dots, hyphens and underscores.",
    );
  const replaced = scene.items.some((item) => item.id === id);
  if (!replaced && scene.items.length >= MAX_ITEMS)
    throw new Error(`A canvas holds at most ${MAX_ITEMS} views. Close one.`);
  const item: CanvasItem = {
    id,
    type: input.type,
    ...(input.title?.trim() ? { title: input.title.trim().slice(0, 80) } : {}),
    state,
  };
  return {
    ...scene,
    items: replaced
      ? scene.items.map((other) => (other.id === id ? item : other))
      : [...scene.items, item],
    active: id,
  };
}

/** The id a new view of this type would get. */
export const nextId = (scene: CanvasScene, type: string) => {
  for (let index = 1; ; index++) {
    const id = `${type}-${index}`;
    if (!scene.items.some((item) => item.id === id)) return id;
  }
};

/** Changes what one view shows, without changing which is in front. */
export function updateItem(
  scene: CanvasScene,
  views: Pick<CanvasViews, "get">,
  id: string,
  input: unknown,
): CanvasScene {
  const item = scene.items.find((other) => other.id === id);
  if (!item) throw new Error(`There is no view "${id}" on this canvas.`);
  const view = views.get(item.type);
  const state = view ? view.parse(input) : undefined;
  if (state === undefined)
    throw new Error(`That is not a valid state for a ${item.type} view.`);
  return {
    ...scene,
    items: scene.items.map((other) =>
      other === item ? { ...item, state } : other,
    ),
  };
}

export function closeItem(scene: CanvasScene, id: string): CanvasScene {
  const index = scene.items.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`There is no view "${id}" on this canvas.`);
  const items = scene.items.filter((item) => item.id !== id);
  const { active: _active, ...rest } = scene;
  const next =
    scene.active === id ? (items[index] ?? items[index - 1])?.id : scene.active;
  return { ...rest, items, ...(next ? { active: next } : {}) };
}

export function activateItem(scene: CanvasScene, id: string): CanvasScene {
  if (!scene.items.some((item) => item.id === id))
    throw new Error(`There is no view "${id}" on this canvas.`);
  return { ...scene, active: id };
}

/** Hands the wheel to `driver`, or frees it. */
export function setDriver(scene: CanvasScene, driver?: string): CanvasScene {
  const { driver: _driver, ...rest } = scene;
  return driver ? { ...rest, driver } : rest;
}

/** The canvas as an agent reads it: what each view shows, never pixels. */
export function describeScene(
  scene: CanvasScene,
  views: Pick<CanvasViews, "get" | "list">,
) {
  return {
    driver: scene.driver ?? null,
    active: scene.active ?? null,
    views: scene.items.map((item) => {
      const view = views.get(item.type);
      return {
        id: item.id,
        type: item.type,
        ...(item.title ? { title: item.title } : {}),
        shows: view
          ? view.describe(item.state)
          : "A view type this app does not have.",
        state: item.state,
      };
    }),
    viewTypes: views.list().map((view) => view.type),
  };
}
