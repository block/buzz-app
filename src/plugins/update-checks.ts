import { gitScope } from "./git-scope";
import { samePluginRelease } from "./same-release";
import type {
  ImportPreview,
  PluginImports,
  PluginInfo,
  PluginRelease,
} from "./types";

type Authorize = (
  repository: string,
) => Promise<{ repository: string; token: string } | null>;
export type UpdateCheck = {
  installedRelease: PluginRelease;
  source: string;
  discoverySource: string;
  sequence: number;
  checking: boolean;
  checkedAt?: number | undefined;
  release: PluginRelease | undefined;
  error: string | null;
  candidate?: ImportPreview["candidates"][number] | undefined;
};
type Snapshot = Readonly<Record<string, UpdateCheck>>;
const identity = (plugin: PluginInfo) => JSON.stringify(plugin.updateSource);
const discoveryIdentity = (source: PluginInfo["updateSource"], pinned = true) =>
  JSON.stringify(
    source && "repository" in source
      ? [
          source.repository,
          source.reference,
          source.path,
          pinned ? source.commit : undefined,
        ]
      : source,
  );
const installation = (plugin: PluginInfo) =>
  JSON.stringify([
    plugin.revision,
    plugin.publisher ?? null,
    plugin.updateSource,
  ]);
export function pluginUpdateCheck(
  snapshot: Snapshot,
  plugin: PluginInfo | undefined,
  discoverySource?: PluginInfo["updateSource"],
) {
  if (!plugin) return undefined;
  const result = snapshot[plugin.manifest.id];
  return samePluginRelease(result?.installedRelease, plugin) &&
    result?.source === identity(plugin) &&
    (discoverySource === undefined ||
      result.discoverySource === discoveryIdentity(discoverySource))
    ? result
    : undefined;
}
export function pluginUpdateAvailable(snapshot: Snapshot, plugin: PluginInfo) {
  const result = pluginUpdateCheck(snapshot, plugin);
  return (
    !!result &&
    !result.error &&
    result.release !== undefined &&
    !samePluginRelease(result.release, plugin)
  );
}

/** Read-only source acquisition and its retained results, shared by list and details. */
export function createPluginUpdateChecks(imports: PluginImports | undefined) {
  let snapshot: Snapshot = {};
  let sequence = 0;
  let gitReads = 0;
  const gitQueue: Array<() => void> = [];
  const installations = new Map<string, string>();
  const listeners = new Set<() => void>();
  const pending = new Map<
    string,
    {
      sequence: number;
      installations: Record<string, string>;
      consumers: Set<() => boolean>;
      promise: Promise<PluginRelease | ImportPreview | null>;
    }
  >();
  const publish = (id: string, result: UpdateCheck) => {
    snapshot = { ...snapshot, [id]: result };
    for (const listener of listeners) listener();
  };
  async function check(
    plugin: PluginInfo,
    authorize?: Authorize,
    folderEligible: () => boolean = () => true,
  ): Promise<void> {
    const source = plugin.updateSource;
    if (
      !imports ||
      plugin.source !== "external" ||
      !source ||
      "url" in source ||
      ("root" in source && !folderEligible())
    )
      return;
    const id = plugin.manifest.id;
    const installed = installation(plugin);
    installations.set(id, installed);
    const current = () => installations.get(id) === installed;
    const key = JSON.stringify(
      "root" in source
        ? ["folder", id, source.root, source.path]
        : ["git", source.repository, source.reference, source.path],
    );
    const active = () => current() && (!("root" in source) || folderEligible());
    let request = pending.get(key);
    if (
      request &&
      ((request.installations[id] !== undefined &&
        request.installations[id] !== installed) ||
        (snapshot[id]?.sequence ?? 0) > request.sequence)
    ) {
      await request.promise.catch(() => {});
      if (active()) return check(plugin, authorize, folderEligible);
      return;
    }
    if (!request) {
      const consumers = new Set([active]);
      const promise = (async () => {
        if ("root" in source) return imports.checkFolder(id);
        if (gitReads >= 2)
          await new Promise<void>((resolve) => gitQueue.push(resolve));
        else gitReads++;
        try {
          if (![...consumers].some((active) => active())) return null;
          const signed = await authorize?.(source.repository);
          if (![...consumers].some((active) => active())) return null;
          return await imports.checkGit(
            signed?.repository ?? source.repository,
            source.reference,
            signed?.token,
            ...gitScope(undefined, source.path),
          );
        } finally {
          const next = gitQueue.shift();
          if (next) next();
          else gitReads--;
        }
      })().finally(() => pending.delete(key));
      request = { sequence: ++sequence, installations: {}, consumers, promise };
      pending.set(key, request);
    }
    request.consumers.add(active);
    request.installations[id] = installed;
    const previous = pluginUpdateCheck(snapshot, plugin);
    const next = {
      installedRelease: {
        revision: plugin.revision,
        publisher: plugin.publisher ?? null,
      },
      source: identity(plugin),
      discoverySource: discoveryIdentity(source, false),
      sequence: request.sequence,
      checking: true,
      checkedAt: previous?.checkedAt,
      release: previous?.release,
      error: null,
    };
    if ((snapshot[id]?.sequence ?? 0) > request.sequence) return;
    publish(id, next);
    let release: PluginRelease | undefined;
    let candidate: ImportPreview["candidates"][number] | undefined;
    let error: string | null = null;
    try {
      const result = await request.promise;
      if (result && "revision" in result) release = result;
      else {
        candidate = (
          result && "candidates" in result ? result.candidates : []
        ).find((item) => item.manifest.id === id && item.path === source.path);
        if (!candidate) {
          const prefix = `${source.path === "." ? "Selected folder" : source.path}:`;
          throw new Error(
            (result && "warnings" in result ? result.warnings : []).find(
              (warning) => warning.startsWith(prefix),
            ) ??
              "The saved repository no longer contains this plugin at its installed path.",
          );
        }
        release = candidate;
      }
    } catch (reason) {
      error = String(reason);
    }
    if (current() && snapshot[id]?.sequence === request.sequence)
      publish(id, {
        ...snapshot[id],
        checking: false,
        ...(active() && {
          release,
          error,
          candidate,
          checkedAt: error ? undefined : Date.now(),
        }),
      });
  }
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    check,
    observe(plugin: PluginInfo, source?: PluginInfo["updateSource"]) {
      const started = ++sequence;
      const installed = installation(plugin);
      installations.set(plugin.manifest.id, installed);
      return (
        release: PluginRelease | undefined,
        error: string | null = null,
        candidate?: ImportPreview["candidates"][number],
      ) => {
        if (
          installations.get(plugin.manifest.id) !== installed ||
          (snapshot[plugin.manifest.id]?.sequence ?? 0) > started
        )
          return false;
        publish(plugin.manifest.id, {
          installedRelease: {
            revision: plugin.revision,
            publisher: plugin.publisher ?? null,
          },
          source: identity(plugin),
          discoverySource: discoveryIdentity(
            source ?? plugin.updateSource,
            source !== undefined,
          ),
          sequence: started,
          checking: false,
          checkedAt: error ? undefined : Date.now(),
          release,
          error,
          candidate,
        });
        return true;
      };
    },
  };
}
export type PluginUpdateChecks = ReturnType<typeof createPluginUpdateChecks>;

// The imports adapter belongs to the plugin manager, which outlives Settings visits.
const sharedChecks = new WeakMap<PluginImports, PluginUpdateChecks>();
export function sharedPluginUpdateChecks(imports: PluginImports | undefined) {
  if (!imports) return createPluginUpdateChecks(imports);
  let checks = sharedChecks.get(imports);
  if (!checks) {
    checks = createPluginUpdateChecks(imports);
    sharedChecks.set(imports, checks);
  }
  return checks;
}
