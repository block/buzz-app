import { managedBy } from "./managed";
import {
  sharedPluginUpdateChecks,
  pluginUpdateCheck,
  type PluginUpdateChecks,
} from "./update-checks";
import type { PluginManager } from "./manager";
import type { ImportPreview, PluginInfo } from "./types";

export type GitUpdateSource = {
  repository: string;
  reference: string;
  path: string;
  commit?: string;
};
export type PluginUpdate = {
  id: string;
  source: GitUpdateSource;
  installedRevision: string;
  candidate?: ImportPreview["candidates"][number];
  error?: string;
};

export function pluginUpdateSource(plugins: PluginManager, id: string) {
  const { configuration } = plugins.snapshot();
  if (configuration.status !== "ready") return;
  const plugin = configuration.catalog.plugins.find(
    (p) => p.manifest.id === id,
  );
  const saved = plugin?.updateSource;
  if (
    plugin?.source !== "external" ||
    !plugin.manifest.updates ||
    !(plugin.updateChecks ?? plugin.manifest.updates.defaultEnabled) ||
    !saved ||
    !("repository" in saved)
  )
    return;
  const managed = managedBy(configuration.managed, id)?.entry;
  if (managed && "url" in managed) return;
  return managed
    ? {
        repository: managed.repository,
        reference: managed.reference,
        path: managed.path,
        commit: managed.commit,
      }
    : {
        repository: saved.repository,
        reference: saved.reference,
        path: saved.path,
      };
}

export const updateSourceKey = (source: GitUpdateSource) =>
  JSON.stringify([
    source.repository,
    source.reference,
    source.path,
    source.commit,
  ]);

export function createPluginUpdates(
  plugins: PluginManager,
  authorizeGit: (
    repository: string,
  ) => Promise<{ repository: string; token: string } | null>,
) {
  let updates: readonly PluginUpdate[] = [];
  let closed = false;
  let pending: Promise<number | undefined> | undefined;
  let retry = false;
  let forceNext = false;
  const checked = new Map<string, { identity: string; at: number }>();
  let lastCheck: number | undefined;
  let lastSources = "";
  const dismissed = new Set<string>();
  const listeners = new Set<() => void>();
  let observedChecks: PluginUpdateChecks | undefined;
  let unsubscribeChecks = () => {};
  const key = (update: PluginUpdate) =>
    `${update.id}:${updateSourceKey(update.source)}:${update.candidate?.revision ?? update.error}`;
  const publish = (next: readonly PluginUpdate[]) => {
    if (closed) return;
    updates = next;
    for (const listener of listeners) listener();
  };
  function installed(id: string): PluginInfo | undefined {
    const { configuration } = plugins.snapshot();
    return configuration.status === "ready"
      ? configuration.catalog.plugins.find(
          (plugin) => plugin.manifest.id === id,
        )
      : undefined;
  }
  function current(update: PluginUpdate) {
    const source = pluginUpdateSource(plugins, update.id);
    return (
      installed(update.id)?.revision === update.installedRevision &&
      source &&
      updateSourceKey(source) === updateSourceKey(update.source)
    );
  }
  const prune = () => {
    const next = updates.flatMap((update) => {
      if (!current(update)) return [];
      const result = pluginUpdateCheck(
        observedChecks?.snapshot() ?? {},
        installed(update.id),
      );
      if (!result || result.checking) return [update];
      if (
        !result.error &&
        result.candidate &&
        result.revision !== update.installedRevision &&
        result.revision !== update.candidate?.revision
      )
        return [
          {
            id: update.id,
            source: update.source,
            installedRevision: update.installedRevision,
            candidate: result.candidate,
          },
        ];
      return (
        update.error
          ? result.error === update.error
          : !result.error && result.revision === update.candidate?.revision
      )
        ? [update]
        : [];
    });
    if (
      next.some((update, index) => update !== updates[index]) ||
      next.length !== updates.length
    )
      publish(next);
  };
  const unsubscribe = plugins.subscribe(prune);
  function sourceIdentity() {
    const { configuration } = plugins.snapshot();
    if (configuration.status !== "ready") return "";
    return JSON.stringify(
      configuration.catalog.plugins.map((plugin) => [
        plugin.manifest.id,
        plugin.revision,
        pluginUpdateSource(plugins, plugin.manifest.id) ??
          (plugin.updateSource && "root" in plugin.updateSource
            ? plugin.updateSource
            : undefined),
      ]),
    );
  }
  async function run(force: boolean) {
    if (closed || !plugins.imports) return;
    const { configuration } = plugins.snapshot();
    if (configuration.status !== "ready") return;
    const now = Date.now();
    const sources = sourceIdentity();
    if (
      !force &&
      sources === lastSources &&
      lastCheck !== undefined &&
      now - lastCheck < 3_600_000
    )
      return;
    lastCheck = now;
    lastSources = sources;
    const checks = sharedPluginUpdateChecks(plugins.imports);
    if (observedChecks !== checks) {
      unsubscribeChecks();
      observedChecks = checks;
      unsubscribeChecks = checks.subscribe(prune);
    }
    // Reserve generations before acquiring a batch: siblings may reuse the
    // same repository snapshot after a newer explicit check has completed.
    const batch = configuration.catalog.plugins.map((plugin) => ({
      plugin,
      source: pluginUpdateSource(plugins, plugin.manifest.id),
      observe: checks.observe(plugin),
    }));
    // Start folder probes before an awaited Git authorization or acquisition.
    batch.sort((a, b) => Number(!!a.source) - Number(!!b.source));
    for (const id of checked.keys())
      if (
        !configuration.catalog.plugins.some(
          (plugin) => plugin.manifest.id === id,
        )
      )
        checked.delete(id);
    const repositories = new Map<string, Promise<ImportPreview | null>>();
    const discover = (source: GitUpdateSource) => {
      const key = JSON.stringify([source.repository, source.reference]);
      let result = repositories.get(key);
      if (!result) {
        result = (async () => {
          const eligible = () => {
            const live = plugins.snapshot().configuration;
            return (
              !closed &&
              live.status === "ready" &&
              live.catalog.plugins.some((plugin) => {
                const current = pluginUpdateSource(plugins, plugin.manifest.id);
                return (
                  current?.repository === source.repository &&
                  current.reference === source.reference
                );
              })
            );
          };
          if (!eligible()) return null;
          const signed = await authorizeGit(source.repository);
          if (!eligible()) return null;
          return (
            plugins.imports?.checkGit(
              signed?.repository ?? source.repository,
              source.reference,
              signed?.token,
            ) ?? null
          );
        })();
        repositories.set(key, result);
      }
      return result;
    };
    for (const { plugin, source, observe } of batch) {
      if (closed) return;
      const id = plugin.manifest.id;
      const folder =
        plugin.source === "external" &&
        plugin.updateSource &&
        "root" in plugin.updateSource &&
        !managedBy(configuration.managed, id);
      if (!source && !folder) {
        checked.delete(id);
        continue;
      }
      const identity = JSON.stringify([
        plugin.revision,
        source ?? plugin.updateSource,
      ]);
      const previous = checked.get(id);
      if (
        !force &&
        previous?.identity === identity &&
        now - previous.at < 3_600_000
      )
        continue;
      checked.set(id, { identity, at: now });
      if (!source) {
        if (folder) {
          const eligible = () => {
            const live = installed(id);
            return (
              !closed &&
              live?.revision === plugin.revision &&
              JSON.stringify(live.updateSource) ===
                JSON.stringify(plugin.updateSource)
            );
          };
          void checks.check(plugin, authorizeGit, true, eligible);
        }
        continue;
      }
      const update: PluginUpdate = {
        id,
        source,
        installedRevision: plugin.revision,
      };
      try {
        const preview = await discover(source);
        if (!preview) throw new Error("No update source found. Try again.");
        if (
          source.commit &&
          preview.commit?.toLowerCase() !== source.commit.toLowerCase()
        )
          throw new Error(
            "The repository does not match the managed commit. Try again after the recommendation is corrected.",
          );
        const candidate = preview.candidates.find(
          (item) => item.manifest.id === id && item.path === source.path,
        );
        if (!candidate)
          throw new Error(
            "The saved repository has no plugin at its installed path.",
          );
        if (candidate.revision !== plugin.revision)
          update.candidate = candidate;
      } catch (reason) {
        update.error =
          reason instanceof Error ? reason.message : String(reason);
      }
      if (!current(update)) continue;
      if (
        !observe?.(
          update.candidate?.revision ?? plugin.revision,
          update.error ?? null,
        )
      ) {
        // A newer explicit result owns both the row and its retained notice.
        prune();
        continue;
      }
      publish([
        ...updates.filter((item) => item.id !== id),
        ...(update.candidate || update.error ? [update] : []),
      ]);
    }
    lastCheck = Math.min(now, ...[...checked.values()].map((item) => item.at));
  }
  return {
    snapshot: () => updates,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hidden: (update: PluginUpdate) => dismissed.has(key(update)),
    later(update: PluginUpdate) {
      dismissed.add(key(update));
      publish([...updates]);
    },
    check(force = false): Promise<number | undefined> {
      retry ||= !!pending && (force || sourceIdentity() !== lastSources);
      forceNext ||= force;
      pending ??= (async () => {
        do {
          const forced = forceNext;
          retry = false;
          forceNext = false;
          await run(forced);
        } while (retry && !closed);
        if (
          closed ||
          !plugins.imports ||
          plugins.snapshot().configuration.status !== "ready"
        )
          return;
        return Math.max(0, (lastCheck ?? Date.now()) + 3_600_000 - Date.now());
      })().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    dispose() {
      closed = true;
      unsubscribe();
      unsubscribeChecks();
      listeners.clear();
    },
  };
}
export type PluginUpdates = ReturnType<typeof createPluginUpdates>;
