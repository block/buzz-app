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
export type InstalledPlugin = Readonly<{
  id: string;
  revision: string;
  enabled: boolean;
}>;
export type PluginInstallOutcome =
  | "installed"
  | "updated"
  | "cancelled"
  | "unavailable";
export type PluginInstaller = Readonly<{
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
const scpRepository = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/+-]+$/;

function gitRepository(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) return null;
  if (/[\s\p{Cc}]/u.test(value)) return null;
  if (scpRepository.test(value)) return value;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "ssh:") ||
      !url.hostname ||
      url.password ||
      (url.protocol === "https:" && url.username) ||
      url.search ||
      url.hash ||
      url.pathname.replaceAll("/", "") === ""
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

export type PluginInstallRequest = Readonly<{
  id: number;
  source: PluginInstallSource;
}>;

export function createPluginInstallRequests() {
  let current:
    | {
        request: PluginInstallRequest;
        resolve(outcome: PluginInstallOutcome): void;
      }
    | undefined;
  let nextId = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => current?.request,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Resolves "unavailable" at once while another request is waiting on the user. */
    request(source: PluginInstallSource): Promise<PluginInstallOutcome> {
      if (current) return Promise.resolve("unavailable");
      return new Promise((resolve) => {
        current = { request: { id: ++nextId, source }, resolve };
        emit();
      });
    },
    settle(id: number, outcome: PluginInstallOutcome) {
      if (current?.request.id !== id) return;
      const { resolve } = current;
      current = undefined;
      resolve(outcome);
      emit();
    },
  };
}
export type PluginInstallRequests = ReturnType<
  typeof createPluginInstallRequests
>;

function installedFrom(
  configuration: ConfigurationState,
): readonly InstalledPlugin[] {
  if (configuration.status !== "ready") return [];
  return configuration.catalog.plugins.map(({ manifest, revision, enabled }) =>
    Object.freeze({ id: manifest.id, revision, enabled }),
  );
}

export class PluginInstallerService extends Service implements PluginInstaller {
  private cache: {
    configuration: ConfigurationState;
    installed: readonly InstalledPlugin[];
  };

  constructor(
    ctx: Context,
    private readonly host: Readonly<{
      plugins: Pick<PluginManager, "snapshot" | "subscribe" | "imports">;
      requests: PluginInstallRequests;
      openPlugins(): Promise<{ status: string }>;
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
          return (
            before?.id === plugin.id &&
            before.revision === plugin.revision &&
            before.enabled === plugin.enabled
          );
        });
      this.cache = {
        configuration,
        installed: same ? this.cache.installed : installed,
      };
    }
    return this.cache.installed;
  };

  subscribe = (listener: () => void) => {
    let last = this.installed();
    return this.host.plugins.subscribe(() => {
      const next = this.installed();
      if (next === last) return;
      last = next;
      listener();
    });
  };

  requestInstall = async (
    source: PluginInstallSource,
  ): Promise<PluginInstallOutcome> => {
    const checked = parsePluginInstallSource(source);
    if (!checked)
      throw new Error(
        "A plugin install request needs an HTTPS, SSH or scp-style Git repository, a branch or tag, and optionally a relative folder and a commit",
      );
    const { plugins, requests } = this.host;
    if (!plugins.imports || plugins.snapshot().configuration.status !== "ready")
      return "unavailable";
    const outcome = requests.request(checked);
    const request = requests.snapshot();
    if (!request || request.source !== checked) return outcome;
    void this.host.openPlugins().then(
      ({ status }) => {
        if (status !== "opened")
          requests.settle(
            request.id,
            status === "failed" ? "unavailable" : "cancelled",
          );
      },
      () => requests.settle(request.id, "unavailable"),
    );
    return outcome;
  };
}
