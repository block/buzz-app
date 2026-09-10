import type { Context } from "@deepseek-ai/cordis";
import type {} from "./status";
import type {} from "./api";

export type Contribution<T> = Readonly<
  T & { key: string; pluginId: string; revision: string }
>;
// Pages and panels share these ownership rules: namespace IDs by plugin, expose
// only active revisions, and remove registrations when their Cordis scope ends.
export function createContributions<T extends { id: string }>(root: Context) {
  let entries: readonly Contribution<T>[] = [];
  let ready: readonly Contribution<T>[] = [];
  const listeners = new Set<() => void>();
  const publish = () => {
    const next = entries.filter((entry) =>
      root.pluginStatus.isActive(entry.pluginId, entry.revision),
    );
    if (
      next.length === ready.length &&
      next.every((entry, i) => entry === ready[i])
    )
      return;
    ready = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  root.effect(() => root.pluginStatus.subscribe(publish));
  return {
    snapshot: () => ready,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    register(ctx: Context, value: T) {
      const owner = ctx.pluginOwner;
      if (!owner)
        throw new Error(
          "Contributions must be registered by an installed plugin",
        );
      const key = `${owner.id}/${value.id}`;
      if (entries.some((entry) => entry.key === key))
        throw new Error(`Contribution already registered: ${key}`);
      const entry = Object.freeze({
        ...value,
        key,
        pluginId: owner.id,
        revision: owner.revision,
      });
      ctx.effect(() => {
        entries = [...entries, entry];
        publish();
        return () => {
          entries = entries.filter((item) => item !== entry);
          publish();
        };
      }, key);
    },
  };
}
