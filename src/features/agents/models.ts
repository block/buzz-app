import type { AgentEdit } from "./control";

/** Missing configuration preserves legacy precedence; Default emits no overrides. */
export type AiConfiguration =
  | { mode: "default" }
  | { mode: "advanced"; effort: EffortSelection };
export type EffortSelection =
  | { kind: "value"; value: string }
  | { kind: "unsupported" };
/** Live discovery evidence, never a static harness setup capability. */
export type EffortOptions =
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
  integration:
    | { kind: "databricks"; settings: { host: string; filter: string } }
    | { kind: "codex" };
  action: "connect" | "refresh" | "disconnect";
}
export interface ModelCatalog {
  integration: { kind: "databricks"; host: string } | { kind: "codex" };
  models: {
    id: string;
    name: string;
    effort?: EffortOptions;
    error?: string;
  }[];
  /** Absent means unknown, including when connected to an older native host. */
  discovery?: {
    source: "databricksCatalog" | "codexAcp";
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
    (catalog.integration.kind === "codex"
      ? catalog.discovery.source === "codexAcp" &&
        (catalog.discovery.catalog === "adapter" ||
          catalog.discovery.catalog === "cached")
      : catalog.discovery.source === "databricksCatalog" &&
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
  const cache = new Map<string, ModelCatalog>();
  const cacheKey = (request: ModelRequest) =>
    JSON.stringify([
      request.id,
      request.expectedRevision,
      request.integration,
      request.edit?.workspace,
      request.edit?.harness.command,
      request.edit?.harness.args,
      request.edit?.harness.provider,

      request.edit?.environment,
    ]);
  const active = new Set<AbortController>();
  let disposed = false;
  return {
    cached(request) {
      const data = cache.get(cacheKey(request));
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
      if (request.integration.kind === "codex") cache.delete(cacheKey(request));
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
      try {
        const begun = host.begin().then((value) => {
          ticket = value;
          if (local.signal.aborted || disposed) retire();
          return value;
        });
        ticket = await Promise.race([begun, cancelled]);
        if (local.signal.aborted || disposed) {
          await host.cancel(ticket);
          throw new Error("Connection cancelled.");
        }
        const result = await Promise.race([
          host.run(ticket, request),
          cancelled,
        ]);
        if (local.signal.aborted || disposed)
          throw new Error("Connection cancelled.");
        if (request.integration.kind === "codex") {
          const key = cacheKey(request);
          cache.delete(key);
          if (cache.size >= 16)
            cache.delete(cache.keys().next().value as string);
          cache.set(key, result);
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
