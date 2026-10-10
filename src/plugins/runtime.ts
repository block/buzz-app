import type { Context, Fiber } from "@deepseek-ai/cordis";
import type { PluginModule } from "./api";
import type { PluginInfo } from "./types";
import { withTimeout } from "./timeout.ts";
import type {} from "./status";
import type { PluginLifecycle } from "./lifecycle";

export type PluginState = {
  revision: string;
  status: "starting" | "active" | "failed";
  error: string | null;
};
export type PluginStates = Record<string, PluginState>;
type Entry = {
  plugin: PluginInfo;
  cancelled: boolean;
  failed: boolean;
  fiber?: Fiber;
  unwatch?: () => void;
  stopped?: Promise<void>;
  predecessor: Promise<void>;
  starting: Promise<void>;
  activation?: number;
};

// Cordis 4.0.2 erases its FiberState const enum from the published JavaScript.
// Keep the version-specific values here, at the lifecycle adapter boundary.
const cordisState = { active: 2, failed: 3, disposed: 4 } as const;

// Internal Cordis adapter. The manager owns configuration; this owns execution.
export class PluginRuntime {
  private readonly root: Context;
  private readonly entries = new Map<string, Entry>();
  private states: PluginStates = {};
  private closed = false;

  private readonly load: (plugin: PluginInfo) => Promise<PluginModule>;
  private readonly listeners = new Set<() => void>();
  private readonly timeoutMs: number;
  private readonly lifecycle?: PluginLifecycle | undefined;

  constructor(
    root: Context,
    load: (plugin: PluginInfo) => Promise<PluginModule>,
    timeoutMs = 10_000,
    lifecycle?: PluginLifecycle,
  ) {
    this.root = root;
    this.load = load;
    root.provide("pluginStatus", {
      isActive: this.isActive,
      subscribe: this.subscribe,
    });
    this.timeoutMs = timeoutMs;
    this.lifecycle = lifecycle;
  }

  snapshot = () => this.states;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  isActive = (id: string, revision: string) => {
    const activation = this.states[id];
    return activation?.status === "active" && activation.revision === revision;
  };
  private publish() {
    for (const listener of this.listeners) listener();
  }

  // The manager chooses desired plugins; this adapter owns only their execution.
  reconcile(plugins: readonly PluginInfo[]) {
    if (this.closed) return;
    const wanted = new Map(
      plugins.map((plugin) => [plugin.manifest.id, plugin]),
    );
    for (const [id, entry] of this.entries) {
      const next = wanted.get(id);
      if (next?.revision === entry.plugin.revision && !entry.cancelled)
        continue;
      // Keep the entry as a teardown barrier: rapid disable/enable must also wait.
      void this.stop(entry).catch(() => {});
      if (id in this.states) {
        const { [id]: _removed, ...rest } = this.states;
        this.states = rest;
        this.publish();
      }
    }
    for (const [id, plugin] of wanted) {
      const previous = this.entries.get(id);
      if (
        previous &&
        !previous.cancelled &&
        previous.plugin.revision === plugin.revision
      )
        continue;
      const entry: Entry = {
        plugin,
        cancelled: false,
        failed: false,
        starting: Promise.resolve(),
        predecessor: previous ? this.stop(previous) : Promise.resolve(),
      };
      this.entries.set(id, entry);
      this.update(entry, "starting", null);
      entry.starting = this.start(entry);
    }
  }

  private update(
    entry: Entry,
    status: PluginState["status"],
    error: string | null,
  ) {
    if (
      this.closed ||
      entry.cancelled ||
      this.entries.get(entry.plugin.manifest.id) !== entry
    )
      return;
    const current = this.states[entry.plugin.manifest.id];
    if (current?.status === status && current.error === error) return;
    this.states = {
      ...this.states,
      [entry.plugin.manifest.id]: {
        revision: entry.plugin.revision,
        status,
        error,
      },
    };
    this.publish();
  }

  private async start(entry: Entry) {
    try {
      await withTimeout(
        entry.predecessor,
        "Previous plugin cleanup timed out; restart the app",
        this.timeoutMs,
      );
      if (entry.cancelled) return;
      const module = await withTimeout(
        this.load(entry.plugin),
        "Plugin loading timed out",
        this.timeoutMs,
      );
      if (entry.cancelled) return;
      if (this.lifecycle) {
        entry.activation = await this.lifecycle.begin(
          entry.plugin.manifest.id,
          entry.plugin.revision,
        );
        if (entry.cancelled) return;
      }
      const scope = this.root.extend({
        pluginOwner: Object.freeze({
          id: entry.plugin.manifest.id,
          revision: entry.plugin.revision,
          ...(entry.activation === undefined
            ? {}
            : { activation: entry.activation }),
        }),
      });
      const fiber = scope.plugin({
        name: entry.plugin.manifest.id,
        inject: module.inject ?? [],
        apply: (ctx: Context) => module.apply(ctx),
      });
      entry.fiber = fiber;
      this.watch(entry, fiber);
    } catch (reason) {
      this.fail(entry, reason);
    }
  }

  private watch(entry: Entry, fiber: Fiber) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (entry.cancelled || entry.failed) return;
      if (fiber.state === cordisState.active) {
        clearTimeout(timer);
        timer = undefined;
        this.update(entry, "active", null);
      } else if (fiber.state === cordisState.failed) {
        // await() retrieves the startup error, but does not wait for missing
        // dependencies. Only the ACTIVE state means contributions are ready.
        void fiber.await().catch((reason) => this.fail(entry, reason));
      } else if (fiber.state === cordisState.disposed) {
        this.fail(entry, new Error("Plugin was disposed"));
      } else {
        this.update(entry, "starting", null);
        timer ??= setTimeout(
          () => this.fail(entry, new Error("Plugin activation timed out")),
          this.timeoutMs,
        );
      }
    };
    const unsubscribe = this.root.on("internal/status", (changed) => {
      // ctx.plugin() returns a wrapper; events carry the underlying fiber.
      if (changed.ctx === fiber.ctx) refresh();
    });
    entry.unwatch = () => {
      clearTimeout(timer);
      unsubscribe();
    };
    refresh();
  }

  private fail(entry: Entry, reason: unknown) {
    if (entry.cancelled || entry.failed) return;
    entry.failed = true;
    entry.unwatch?.();
    this.update(entry, "failed", String(reason));
    // Failure stays visible until an explicit retry. Retain the cleanup barrier
    // so replacement also waits for disposal started by a timeout or error.
    entry.stopped ??= this.teardown(entry);
    void entry.stopped.catch(() => {});
  }

  private stop(entry: Entry): Promise<void> {
    entry.cancelled = true;
    entry.unwatch?.();
    entry.stopped ??= this.teardown(entry);
    return entry.stopped;
  }

  private async teardown(entry: Entry) {
    // Include a pending native begin/module load before fencing late resources.
    await entry.starting;
    await entry.predecessor;
    try {
      await entry.fiber?.dispose();
    } finally {
      if (entry.activation !== undefined)
        await this.lifecycle?.retire(
          entry.plugin.manifest.id,
          entry.activation,
        );
    }
  }

  async dispose() {
    this.closed = true;
    const cleanup = [...this.entries.values()].map((entry) => this.stop(entry));
    this.states = {};
    this.publish();
    await Promise.all(cleanup);
  }
}
