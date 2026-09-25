import type { AgentControl, AgentView } from "./control";
import type { AgentLibrarySnapshot, createAgentLibrary } from "./library";
import type { ChannelList } from "../relay/contracts";
import { relayOrigin } from "../communities/destination";

/** Community evidence, not process readiness or permission to grant access. */
export function sameCommunityAgents(
  agents: readonly AgentView[],
  scope: string,
) {
  const viewer = scope.slice(-64);
  if (!/^[0-9a-f]{64}$/.test(viewer)) return [];
  return agents.filter((agent) => {
    try {
      return `${relayOrigin(agent.relayUrl)}:${viewer}` === scope;
    } catch {
      return false;
    }
  });
}

type Choice = AgentLibrarySnapshot["identities"][number] & { managed: boolean };
export type AgentChoicesSnapshot = Omit<AgentLibrarySnapshot, "identities"> & {
  identities: readonly Choice[];
  /** Usable candidates do not imply complete evidence for automatic recipients. */
  complete: boolean;
  pending: boolean;
};

/** One read-only projection of existing sources. No directory scan, timer, runner
 * or write authority. The relay session owns its lifetime; native owns processes. */
export function createAgentChoices({
  scope,
  library,
  native,
  signal,
}: {
  scope: string;
  library: ReturnType<typeof createAgentLibrary>["queries"];
  native?: Pick<AgentControl, "snapshot" | "subscribe" | "refresh"> | undefined;
  signal: AbortSignal;
}) {
  const empty: AgentChoicesSnapshot = {
    status: "unavailable",
    definitions: [],
    identities: [],
    complete: false,
    pending: false,
  };
  let cached:
    | {
        legacy: AgentLibrarySnapshot;
        local: ReturnType<AgentControl["snapshot"]> | undefined;
        value: AgentChoicesSnapshot;
      }
    | undefined;
  const snapshot = (): AgentChoicesSnapshot => {
    if (signal.aborted) return empty;
    const legacy = library.snapshot(),
      local = native?.snapshot();
    if (cached?.legacy === legacy && cached.local === local)
      return cached.value;
    const choices = new Map<string, Choice>();
    if (legacy.status === "ready")
      for (const row of legacy.identities)
        choices.set(row.pubkey, { ...row, managed: false });
    if (local?.status === "ready")
      for (const row of sameCommunityAgents(local.data?.agents ?? [], scope)) {
        // Keep existing source names in serialized mentions; the shared name
        // resolver supplies native display labels independently.
        choices.set(row.pubkey, {
          pubkey: row.pubkey,
          name: row.name,
          ...choices.get(row.pubkey),
          ...(row.picture == null ? {} : { avatar: row.picture }),
          managed: true,
        });
      }
    const ready = legacy.status === "ready" || local?.status === "ready";
    const errors = [
      legacy.error,
      local?.status === "error" ? local.error : undefined,
    ].filter(Boolean);
    const value: AgentChoicesSnapshot = {
      status: ready
        ? "ready"
        : errors.length
          ? "error"
          : legacy.status === "loading" || local?.status === "loading"
            ? "loading"
            : legacy.status === "idle" || local?.status === "idle"
              ? "idle"
              : "unavailable",
      pending:
        legacy.status === "idle" ||
        legacy.status === "loading" ||
        local?.status === "idle" ||
        local?.status === "loading",
      complete:
        legacy.status === "ready" &&
        (!local || local.status === "ready" || local.status === "unavailable"),
      definitions: legacy.status === "ready" ? legacy.definitions : [],
      identities: [...choices.values()],
      ...(errors.length ? { error: errors.join(" ") } : {}),
    };
    cached = { legacy, local, value };
    return value;
  };
  return Object.freeze({
    snapshot,
    subscribe(listener: () => void) {
      if (signal.aborted) return () => {};
      const stopLibrary = library.subscribe(listener),
        stopNative = native?.subscribe(listener);
      const stop = () => {
        stopLibrary();
        stopNative?.();
        signal.removeEventListener("abort", retired);
      };
      const retired = () => {
        stop();
        listener();
      };
      signal.addEventListener("abort", retired, { once: true });
      return stop;
    },
    ensure(includeLegacy = true) {
      if (signal.aborted) return;
      if (includeLegacy && library.snapshot().status === "idle")
        void library.refresh();
      if (native?.snapshot().status === "idle") void native.refresh();
    },
    async refresh(includeLegacy = true) {
      if (signal.aborted) return;
      await Promise.all([
        includeLegacy ? library.refresh() : undefined,
        native?.refresh(),
      ]);
    },
    retain() {
      if (signal.aborted) return () => {};
      // Demand survives reconnect; ensure/explicit Refresh owns reads. A fresh
      // completion mount must not replace ready evidence with loading state.
      return library.retain({ refresh: false });
    },
  });
}

/** Legacy definitions have no destination evidence; templates retain the visible
 * community roster constraint. Native identities already carry an exact origin. */
export function templateAgentChoices(
  agents: AgentChoicesSnapshot,
  channels: ChannelList,
) {
  const members = new Set(
    channels.status === "ready"
      ? channels.channels.flatMap((c) => c.members ?? [])
      : [],
  );
  return agents.identities.filter(
    (agent) => agent.managed || members.has(agent.pubkey),
  );
}
