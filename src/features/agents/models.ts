import type { AgentEdit } from "./control";

/** Missing configuration preserves legacy precedence; Default emits no overrides. */
export type AiConfiguration =
  | { mode: "default" }
  | { mode: "advanced"; effort: EffortSelection };
export type EffortSelection =
  | { kind: "default" }
  | { kind: "value"; value: string }
  | { kind: "unsupported" };
/** Live discovery evidence, never a static harness setup capability. */
export type EffortOptions =
  | { status: "default" }
  | { status: "unknown" }
  | { status: "unsupported" }
  | { status: "supported"; options: { value: string; name: string }[] };
export type ModelErrorCode =
  | "authentication"
  | "model"
  | "effort"
  | "configuration"
  | "unavailable"
  | "timeout"
  | "cancelled";
export class ModelError extends Error {
  constructor(
    public readonly code: ModelErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ModelRequest {
  id?: string | undefined;
  expectedRevision?: number | undefined;
  edit?: AgentEdit | undefined;
  /** New callers identify the integration explicitly. Older Databricks callers
   * retain host/filter until their UI is migrated. Native accepts both shapes. */
  integration?:
    | { kind: "databricks"; settings: { host: string; filter: string } }
    | { kind: "codex" }
    | { kind: "openai"; settings: { apiKey?: string } }
    | { kind: "goose" }
    | { kind: "pi" };
  host?: string;
  filter?: string;
  /** "test" is Pi only: one tiny prompt with the draft provider and model. */
  action: "connect" | "refresh" | "disconnect" | "test";
  /** Blank host/filter come from write-only Agent defaults; native supplies them. */
  inheritWorkspace?: boolean;
}
export interface ModelCatalog {
  integration?:
    | { kind: "databricks"; host: string }
    | { kind: "codex" }
    | { kind: "openai" }
    | { kind: "goose" }
    | { kind: "pi" };
  /** Legacy Databricks hosts return this alongside the catalog. */
  host?: string;
  models: {
    id: string;
    name: string;
    effort?: EffortOptions;
    error?: string;
  }[];
  /** Absent means unknown, including when connected to an older native host. */
  discovery?: {
    source: "databricksCatalog" | "codexAcp" | "openaiCatalog";
    authentication: "authenticated" | "unknown";
    /** Omission from an older host is unverified, not proof of a remote fetch. */
    catalog?: "adapter" | "remote" | "cached" | "fallback" | "unknown";
  } | null;
  /** Effective initial ACP session settings, before any model selection. */
  defaults?: { model: string | null; effort: string | null } | null;
  modelOverridden: boolean;
  disconnected: boolean;
}

/** App-session Codex cache can drive the UI; native creation always revalidates. */
export function isVerifiedCatalog(catalog: ModelCatalog | null): boolean {
  return (
    !!catalog &&
    !catalog.disconnected &&
    catalog.discovery?.authentication === "authenticated" &&
    (catalog.integration?.kind === "codex"
      ? catalog.discovery.source === "codexAcp" &&
        (catalog.discovery.catalog === "adapter" ||
          catalog.discovery.catalog === "cached")
      : catalog.integration?.kind === "openai"
        ? catalog.discovery.source === "openaiCatalog" &&
          catalog.discovery.catalog === "remote"
        : catalog.integration?.kind === "databricks" &&
          catalog.discovery.source === "databricksCatalog" &&
          catalog.discovery.catalog === "remote")
  );
}
export interface ModelHost {
  begin(): Promise<number>;
  run(ticket: number, request: ModelRequest): Promise<ModelCatalog>;
  cancel(ticket: number): Promise<void>;
}
export interface AgentModels {
  cached?(request: ModelRequest): ModelCatalog | undefined;
  request(request: ModelRequest, signal: AbortSignal): Promise<ModelCatalog>;
}

/** Separate lane from Save/Stop. A ticket handshake lets cancellation overtake
 * slow begin responses without launching stale auth work. No passive calls. */
export function createAgentModels(
  host: ModelHost | undefined,
): AgentModels & { dispose(): void } {
  // Owned by the app's control service; never persisted with environment secrets.
  const cache = new Map<
    string,
    { data: ModelCatalog; expires: number; fullCatalog: boolean }
  >();
  // Draft environment patches can contain credentials. Do not retain them, or
  // reuse catalog evidence across unpersisted credential/configuration changes.
  const cacheable = (request: ModelRequest) =>
    !Object.keys(request.edit?.environment ?? {}).length;
  const cacheKey = (request: ModelRequest) =>
    JSON.stringify([
      request.id,
      request.expectedRevision,
      request.integration,
      request.edit?.workspace,
      request.edit?.harness.command,
      request.edit?.harness.args,
      request.edit?.harness.provider,
    ]);
  const needsFullCatalog = (request: ModelRequest) =>
    request.edit?.harness.configuration?.mode === "advanced";
  const active = new Set<AbortController>();
  // Native admits one lookup and holds it until a cancelled one is dropped. A
  // replacement waits for that retirement instead of being refused as busy.
  const retiring = new Set<Promise<unknown>>();
  let disposed = false;
  return {
    cached(request) {
      if (request.integration?.kind !== "codex" || !cacheable(request))
        return undefined;
      const key = cacheKey(request);
      const entry = cache.get(key);
      if (entry && Date.now() >= entry.expires) {
        cache.delete(key);
        return undefined;
      }
      if (needsFullCatalog(request) && !entry?.fullCatalog) return undefined;
      const data = entry?.data;
      return data
        ? {
            ...data,
            discovery: data.discovery
              ? { ...data.discovery, catalog: "cached" }
              : null,
          }
        : undefined;
    },
    async request(request, signal) {
      if (!host || disposed)
        throw new Error("Model connections require a rebuilt desktop app.");
      if (signal.aborted) throw new Error("Connection cancelled.");
      if (request.integration?.kind === "codex")
        cache.delete(cacheKey(request));
      const local = new AbortController();
      active.add(local);
      let ticket: number | undefined;
      const cancel = () => local.abort();
      const retire = () => {
        if (ticket !== undefined) void host.cancel(ticket).catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      local.signal.addEventListener("abort", retire, { once: true });
      let rejectCancelled: (() => void) | undefined;
      const cancelled = new Promise<never>((_, reject) => {
        rejectCancelled = () => reject(new Error("Connection cancelled."));
        local.signal.addEventListener("abort", rejectCancelled, { once: true });
      });
      const timer = setTimeout(cancel, 185_000);
      let running: Promise<ModelCatalog> | undefined;
      try {
        if (retiring.size) {
          await Promise.race([Promise.allSettled([...retiring]), cancelled]);
          if (local.signal.aborted || disposed)
            throw new Error("Connection cancelled.");
        }
        const begun = host.begin().then((value) => {
          ticket = value;
          if (local.signal.aborted || disposed) retire();
          return value;
        });
        local.signal.addEventListener(
          "abort",
          () => {
            const retired = begun
              .then((value): Promise<unknown> => running ?? host.cancel(value))
              .catch(() => {})
              .finally(() => retiring.delete(retired));
            retiring.add(retired);
          },
          { once: true },
        );
        ticket = await Promise.race([begun, cancelled]);
        if (local.signal.aborted || disposed) {
          await host.cancel(ticket);
          throw new Error("Connection cancelled.");
        }
        running = host.run(ticket, request);
        const result = await Promise.race([running, cancelled]);
        if (local.signal.aborted || disposed)
          throw new Error("Connection cancelled.");
        if (request.integration?.kind === "codex" && cacheable(request)) {
          const key = cacheKey(request);
          cache.delete(key);
          if (cache.size >= 16)
            cache.delete(cache.keys().next().value as string);
          cache.set(key, {
            data: result,
            expires: Date.now() + 60_000,
            fullCatalog: needsFullCatalog(request),
          });
        }
        return result;
      } catch (error) {
        // Native supplies deliberately safe strings. Never surface arbitrary
        // Error contents from the transport or third-party dependencies.
        if (!local.signal.aborted && isModelFailure(error))
          throw new ModelError(error.code, error.message);
        throw new ModelError(
          local.signal.aborted ? "cancelled" : "unavailable",
          local.signal.aborted
            ? "Connection cancelled."
            : typeof error === "string"
              ? error
              : "Could not load models. Retry explicitly; your model entry is unchanged.",
        );
      } finally {
        clearTimeout(timer);
        if (rejectCancelled)
          local.signal.removeEventListener("abort", rejectCancelled);
        signal.removeEventListener("abort", cancel);
        local.signal.removeEventListener("abort", retire);
        active.delete(local);
        if (ticket !== undefined) void host.cancel(ticket).catch(() => {});
      }
    },
    dispose() {
      disposed = true;
      for (const request of active) request.abort();
      active.clear();
      cache.clear();
    },
  };
}

export function isModelFailure(
  value: unknown,
): value is { code: ModelErrorCode; message: string } {
  if (!value || typeof value !== "object") return false;
  const error = value as Record<string, unknown>;
  return (
    typeof error.message === "string" &&
    typeof error.code === "string" &&
    [
      "authentication",
      "model",
      "effort",
      "configuration",
      "unavailable",
      "timeout",
      "cancelled",
    ].includes(error.code)
  );
}
