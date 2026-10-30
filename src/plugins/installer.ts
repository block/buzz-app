import { Service, type Context } from "@deepseek-ai/cordis";
import type { PluginManager } from "./manager";
import type { ConfigurationState } from "./types";

export type PluginInstallSource = Readonly<{
  repository: string;
  reference: string;
  path?: string;
  /** Install exactly this commit; the import is refused if the fetched head differs. */
  commit?: string;
}>;
export type InstalledPlugin = Readonly<{ id: string; enabled: boolean }>;
export type PluginInstallOutcome =
  | "installed"
  | "updated"
  | "cancelled"
  | "unavailable";
export type PluginInstaller = Readonly<{
  /** Ungated: every active plugin can read which plugins are installed and enabled. */
  installed(): readonly InstalledPlugin[];
  subscribe(listener: () => void): () => void;
  /** Opens Settings → Plugins for the user to review; it never installs silently. */
  requestInstall(source: PluginInstallSource): Promise<PluginInstallOutcome>;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Read with `ctx.reflect.get("pluginInstaller")` for old-host compatibility. */
    pluginInstaller?: PluginInstaller;
  }
}

const reference = /^[A-Za-z0-9._/-]{1,200}$/;
const pathSegment = /^[A-Za-z0-9._@+-]{1,100}$/;
const commit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const scpRepository = /^git@([A-Za-z0-9.-]+):([A-Za-z0-9._~/+-]+)$/;

function githubTree(host: string, path: string) {
  return (
    host.toLowerCase() === "github.com" &&
    path.split("/").filter(Boolean).length !== 2
  );
}

function gitRepository(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) return null;
  if (/[\s\p{Cc}\p{Cf}\P{ASCII}]/u.test(value)) return null;
  const scp = scpRepository.exec(value);
  if (scp)
    return scp[1]?.startsWith("-") || githubTree(scp[1] ?? "", scp[2] ?? "")
      ? null
      : value;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "ssh:") ||
      !url.hostname ||
      url.hostname.startsWith("-") ||
      url.password ||
      (url.protocol === "https:" && url.username) ||
      (url.protocol === "ssh:" && url.username && url.username !== "git") ||
      url.search ||
      url.hash ||
      url.pathname.replaceAll("/", "") === "" ||
      githubTree(url.hostname, url.pathname)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

function gitReference(value: unknown) {
  if (
    typeof value !== "string" ||
    !reference.test(value) ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.includes("..")
  )
    return null;
  return value;
}

function relativePath(value: unknown) {
  if (value === ".") return value;
  if (typeof value !== "string" || value.length > 512) return null;
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment !== "." && segment !== ".." && pathSegment.test(segment),
  )
    ? value
    : null;
}

/** The normalized request, or null when any field is outside the accepted grammar. */
export function parsePluginInstallSource(
  input: unknown,
): PluginInstallSource | null {
  if (!input || typeof input !== "object") return null;
  const {
    repository,
    reference: ref,
    path,
    commit: pin,
  } = input as Record<string, unknown>;
  const normalizedRepository = gitRepository(repository);
  const normalizedReference = gitReference(ref);
  if (!normalizedRepository || !normalizedReference) return null;
  const normalizedPath = path === undefined ? undefined : relativePath(path);
  if (normalizedPath === null) return null;
  let normalizedCommit: string | undefined;
  if (pin !== undefined) {
    if (typeof pin !== "string" || !commit.test(pin.toLowerCase())) return null;
    normalizedCommit = pin.toLowerCase();
  }
  return {
    repository: normalizedRepository,
    reference: normalizedReference,
    ...(normalizedPath === undefined ? {} : { path: normalizedPath }),
    ...(normalizedCommit === undefined ? {} : { commit: normalizedCommit }),
  };
}

export type PluginInstallOrigin = Readonly<
  { kind: "plugin"; id: string; name: string } | { kind: "link" }
>;
export type PluginInstallRequest = Readonly<{
  id: number;
  source: PluginInstallSource;
  origin: PluginInstallOrigin;
}>;

export function createPluginInstallRequests({
  ttlMs = 60_000,
}: {
  ttlMs?: number;
} = {}) {
  let current:
    | {
        request: PluginInstallRequest;
        resolve(outcome: PluginInstallOutcome): void;
        timer: ReturnType<typeof setTimeout> | undefined;
      }
    | undefined;
  let nextId = 0;
  let reviews = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const settle = (id: number, outcome: PluginInstallOutcome) => {
    if (current?.request.id !== id) return;
    const { resolve, timer } = current;
    clearTimeout(timer);
    current = undefined;
    resolve(outcome);
    emit();
  };
  return {
    snapshot: () => current?.request,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Resolves "unavailable" at once while another request or any review is open. */
    request(
      source: PluginInstallSource,
      origin: PluginInstallOrigin,
    ): Promise<PluginInstallOutcome> {
      if (current || reviews > 0) return Promise.resolve("unavailable");
      return new Promise((resolve) => {
        const id = ++nextId;
        current = {
          request: { id, source, origin },
          resolve,
          timer: setTimeout(() => settle(id, "cancelled"), ttlMs),
        };
        emit();
      });
    },
    /** A review dialog took the request; it now lives as long as that dialog. */
    claim(id: number) {
      if (current?.request.id !== id) return;
      clearTimeout(current.timer);
      current.timer = undefined;
    },
    /** Marks a plugin review dialog as open until the returned function runs. */
    holdReview() {
      reviews++;
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        reviews--;
      };
    },
    settle,
  };
}
export type PluginInstallRequests = ReturnType<
  typeof createPluginInstallRequests
>;

type Clock = () => number;
const cooldownMs = 5_000;
const maxCooldownMs = 5 * 60_000;
const sessionLimit = 20;

function createInstallPolicy(now: Clock) {
  const callers = new Map<
    string,
    { accepted: number; cancels: number; until: number }
  >();
  const state = (id: string) => {
    const known = callers.get(id);
    if (known) return known;
    const entry = { accepted: 0, cancels: 0, until: 0 };
    callers.set(id, entry);
    return entry;
  };
  return {
    allowed(id: string) {
      const entry = state(id);
      return entry.accepted < sessionLimit && now() >= entry.until;
    },
    accepted(id: string) {
      state(id).accepted++;
    },
    finished(id: string, outcome: PluginInstallOutcome) {
      const entry = state(id);
      if (outcome === "cancelled") {
        entry.cancels++;
        entry.until =
          now() +
          Math.min(cooldownMs * 2 ** (entry.cancels - 1), maxCooldownMs);
      } else if (outcome !== "unavailable") {
        entry.cancels = 0;
        entry.until = 0;
      }
    },
  };
}

function displayName(name: string, fallback: string) {
  const clean = name
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
    .slice(0, 80);
  return clean || fallback;
}

function installedFrom(
  configuration: ConfigurationState,
): readonly InstalledPlugin[] {
  if (configuration.status !== "ready") return Object.freeze([]);
  const paused = configuration.externalPluginsPaused;
  return Object.freeze(
    configuration.catalog.plugins.map(({ manifest, enabled, source }) =>
      Object.freeze({
        id: manifest.id,
        enabled: enabled && !(paused && source === "external"),
      }),
    ),
  );
}

type InstallHost = Readonly<{
  plugins: Pick<PluginManager, "snapshot" | "subscribe" | "imports">;
  requests: PluginInstallRequests;
  openPlugins(): Promise<{ status: string }>;
  /** Plugin calls need a recent user gesture where the platform reports one. */
  activation?: () => boolean;
  now?: Clock;
}>;

const invalidSource =
  "A plugin install request needs an HTTPS, SSH or scp-style Git repository, a branch or tag, and optionally a relative folder and a commit";

/** The one place a request is admitted; a plugin's service and an OS link share it. */
export function createPluginInstallCore({
  plugins,
  requests,
  openPlugins,
  activation = () => globalThis.navigator?.userActivation?.isActive ?? true,
  now = Date.now,
}: InstallHost) {
  const policy = createInstallPolicy(now);
  return {
    async submit(
      source: PluginInstallSource,
      caller?: Readonly<{ id: string }>,
    ): Promise<PluginInstallOutcome> {
      const checked = parsePluginInstallSource(source);
      if (!checked) throw new Error(invalidSource);
      if (caller && (!activation() || !policy.allowed(caller.id)))
        return "unavailable";
      const { configuration } = plugins.snapshot();
      if (!plugins.imports || configuration.status !== "ready")
        return "unavailable";
      const name =
        configuration.catalog.plugins.find(
          (plugin) => plugin.manifest.id === caller?.id,
        )?.manifest.name ?? "";
      const outcome = requests.request(
        checked,
        caller
          ? {
              kind: "plugin",
              id: caller.id,
              name: displayName(name, caller.id),
            }
          : { kind: "link" },
      );
      const request = requests.snapshot();
      if (!request || request.source !== checked) return outcome;
      if (caller) policy.accepted(caller.id);
      void openPlugins().then(
        ({ status }) => {
          if (status !== "opened")
            requests.settle(
              request.id,
              status === "failed" ? "unavailable" : "cancelled",
            );
        },
        () => requests.settle(request.id, "unavailable"),
      );
      const result = await outcome;
      if (caller) policy.finished(caller.id, result);
      return result;
    },
  };
}
export type PluginInstallCore = ReturnType<typeof createPluginInstallCore>;

/** Holds an OS link through plugin settings loading, newest link first. */
export function createPluginInstallLinkHandler({
  plugins,
  core,
  fail,
}: Readonly<{
  plugins: Pick<PluginManager, "snapshot" | "subscribe">;
  core: PluginInstallCore;
  fail(
    reason: "unavailable",
    retry: () => Promise<{ status: "cancelled" }>,
  ): void;
}>) {
  let stopWaiting: (() => void) | undefined;
  const handle = (link: Readonly<{ source: PluginInstallSource }>) => {
    stopWaiting?.();
    stopWaiting = undefined;
    const run = () => {
      void core.submit(link.source).then((outcome) => {
        if (outcome === "unavailable")
          fail("unavailable", async () => {
            handle(link);
            return { status: "cancelled" };
          });
      });
    };
    if (plugins.snapshot().configuration.status !== "loading") return run();
    const stop = plugins.subscribe(() => {
      if (plugins.snapshot().configuration.status === "loading") return;
      stop();
      if (stopWaiting === stop) stopWaiting = undefined;
      run();
    });
    stopWaiting = stop;
  };
  return {
    handle,
    dispose() {
      stopWaiting?.();
      stopWaiting = undefined;
    },
  };
}

export class PluginInstallerService extends Service implements PluginInstaller {
  private cache: {
    configuration: ConfigurationState;
    installed: readonly InstalledPlugin[];
  };

  constructor(
    ctx: Context,
    private readonly host: Readonly<{
      plugins: Pick<PluginManager, "snapshot" | "subscribe">;
      core: PluginInstallCore;
    }>,
  ) {
    super(ctx, "pluginInstaller");
    const { configuration } = host.plugins.snapshot();
    this.cache = { configuration, installed: installedFrom(configuration) };
  }

  installed = () => {
    const { configuration } = this.host.plugins.snapshot();
    if (configuration !== this.cache.configuration) {
      const installed = installedFrom(configuration);
      const same =
        installed.length === this.cache.installed.length &&
        installed.every((plugin, index) => {
          const before = this.cache.installed[index];
          return before?.id === plugin.id && before.enabled === plugin.enabled;
        });
      this.cache = {
        configuration,
        installed: same ? this.cache.installed : installed,
      };
    }
    return this.cache.installed;
  };

  // Methods, not arrow properties: Cordis gives them the calling plugin's
  // context, which is how a request is attributed and a subscription is owned.
  subscribe(listener: () => void) {
    let last = this.installed();
    const stop = this.ctx.effect(() =>
      this.host.plugins.subscribe(() => {
        const next = this.installed();
        if (next === last) return;
        last = next;
        try {
          listener();
        } catch (error) {
          console.error("A plugin installer listener failed", error);
        }
      }),
    );
    return () => void stop();
  }

  requestInstall(source: PluginInstallSource): Promise<PluginInstallOutcome> {
    const owner = this.ctx.pluginOwner;
    if (!owner)
      return Promise.reject(
        new Error("Plugin installs must be requested by an installed plugin"),
      );
    return this.host.core.submit(source, owner);
  }
}
