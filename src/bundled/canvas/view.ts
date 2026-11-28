import type { ComponentType } from "react";

/** What a view receives. It renders from `state` alone, so a follower's copy
 * shows what the driver's does. */
export type CanvasViewProps<S> = {
  state: S;
  /** False while this viewer follows someone else's driving. */
  interactive: boolean;
  /** Report a change the viewer made, such as a navigation or a map move. */
  update(next: S): void;
};

/** One kind of thing a canvas can hold. `state` is plain JSON the type owns. */
export type CanvasViewType<S = unknown> = {
  /** Stable name saved in scenes: lowercase letters, digits and `-`. */
  type: string;
  title: string;
  /** Validates untrusted JSON from the relay or an agent. Undefined refuses it. */
  parse(input: unknown): S | undefined;
  /** One line telling an agent what the view shows. Agents never see pixels. */
  describe(state: S): string;
  /** The state of a new, empty view. With it people can add one from the
   * canvas; without it only agents can open one. */
  initial?: S;
  component: ComponentType<CanvasViewProps<S>>;
};

export type CanvasViews = {
  register<S>(view: CanvasViewType<S>): () => void;
  get(type: string): CanvasViewType | undefined;
  list(): readonly CanvasViewType[];
  subscribe(listener: () => void): () => void;
};

/** The layer under the canvas: any plugin can add a view type to it. */
export function createCanvasViews(): CanvasViews {
  let views: readonly CanvasViewType[] = [];
  const listeners = new Set<() => void>();
  const set = (next: readonly CanvasViewType[]) => {
    views = next;
    for (const listener of listeners) listener();
  };
  return {
    register(view) {
      if (
        !/^[a-z][a-z0-9-]{0,31}$/.test(view.type) ||
        !view.title.trim() ||
        typeof view.parse !== "function" ||
        typeof view.describe !== "function" ||
        typeof view.component !== "function"
      )
        throw new Error(
          "A canvas view needs a type, title, parse, describe and component",
        );
      if (views.some((other) => other.type === view.type))
        throw new Error(`Canvas view "${view.type}" is already registered`);
      const entry = view as CanvasViewType;
      set([...views, entry]);
      return () => set(views.filter((other) => other !== entry));
    },
    get: (type) => views.find((view) => view.type === type),
    list: () => views,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
