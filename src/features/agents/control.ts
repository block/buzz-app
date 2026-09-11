/** Native-owned configuration and process evidence; never a relay-session capability. */
// Keep injection reachable from the generated author contract, not host construction.
import type {} from "@deepseek-ai/cordis";
declare module "@deepseek-ai/cordis" {
  interface Context {
    agentControl: AgentControl;
  }
}
export type AgentAction = "start" | "stop" | "restart";
export type ImportSource = "installed" | "development";
export interface AgentView {
  id: string;
  pubkey: string;
  relayUrl: string;
  name: string;
  systemPrompt: string;
  workspace: string;
  harness: {
    command: string;
    args: string[];
    model: string;
    provider: string;
    environmentKeys: string[];
  };
  revision: number;
  runningRevision: number | null;
  enabled: boolean;
  status: "stopped" | "starting" | "running" | "stopping" | "failed";
  error: string | null;
  diagnostics: string[];
}
export interface ControlSnapshot {
  agents: AgentView[];
  runtimeAvailable: boolean;
  /** False while native credential/import acceptance is outstanding. */
  importAvailable?: boolean;
  runtimeMessage?: string | null;
}
export interface AgentEdit {
  name: string;
  systemPrompt: string;
  workspace: string;
  harness: Omit<AgentView["harness"], "environmentKeys">;
  /** Missing preserves the native value; null removes it; string replaces it. */
  environment: Record<string, string | null>;
}
export interface AgentImportPreview {
  token: string;
  sourcePath: string;
  candidates: Pick<AgentView, "id" | "pubkey" | "relayUrl" | "name">[];
  warnings: string[];
}
export interface AgentControlHost {
  snapshot(): Promise<ControlSnapshot>;
  save(
    id: string,
    expectedRevision: number,
    edit: AgentEdit,
  ): Promise<ControlSnapshot>;
  action(id: string, action: AgentAction): Promise<ControlSnapshot>;
  previewImport(source: ImportSource): Promise<AgentImportPreview>;
  commitImport(token: string, ids: string[]): Promise<ControlSnapshot>;
}
export interface AgentControlState {
  status: "idle" | "loading" | "ready" | "error" | "unavailable";
  data: ControlSnapshot | null;
  busy: boolean;
  error: string | null;
}
export interface AgentControl {
  snapshot(): AgentControlState;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  save: AgentControlHost["save"];
  action: AgentControlHost["action"];
  previewImport: AgentControlHost["previewImport"];
  commitImport: AgentControlHost["commitImport"];
}

/** Stop is recovery, not a launch: stale stopped/disabled evidence cannot veto it. */
export function canStopAgent(state: AgentControlState, id: string): boolean {
  if (state.busy) return false;
  const agent = state.data?.agents.find((candidate) => candidate.id === id);
  return (
    !!agent &&
    (state.status === "error" ||
      (state.status === "ready" &&
        (agent.enabled || agent.status !== "stopped")))
  );
}

export const agentControlUnavailable =
  "Local agent controls require the desktop app. This browser cannot run or manage agent processes.";

/** Own once at app composition. Disposing this projection never stops native agents. */
export function createAgentControl(
  host: AgentControlHost | null,
): AgentControl & { dispose(): void } {
  let state: AgentControlState = {
    status: host ? "idle" : "unavailable",
    data: null,
    busy: false,
    error: host ? null : agentControlUnavailable,
  };
  const listeners = new Set<() => void>();
  let disposed = false;
  let generation = 0;
  let read: Promise<void> | null = null;
  const update = (patch: Partial<AgentControlState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const ready = (data: ControlSnapshot) =>
    update({ status: "ready", data, error: null });

  function refresh(): Promise<void> {
    if (!host || disposed || state.busy) return Promise.resolve();
    if (read) return read;
    const current = generation;
    if (!state.data) update({ status: "loading", error: null });
    const pending = Promise.resolve()
      .then(() => host.snapshot())
      .then(
        (data) => {
          if (current === generation) ready(data);
        },
        () => {
          if (current === generation)
            update({
              status: "error",
              error:
                "Could not refresh local agents. Retry to get current host status.",
            });
        },
      )
      .finally(() => {
        if (read === pending) read = null;
      });
    read = pending;
    return pending;
  }

  async function run<T>(
    operation: (host: AgentControlHost) => Promise<T>,
    apply: (result: T) => void,
    allowRecoveryStop = false,
  ): Promise<T> {
    if (!host || disposed) throw new Error(agentControlUnavailable);
    if (state.busy) throw new Error("Another agent operation is in progress.");
    if (state.status !== "ready" && !allowRecoveryStop)
      throw new Error("Refresh local agents before trying again.");
    const current = ++generation;
    // A pre-write read must not overwrite this command, even when it completes later.
    read = null;
    update({ busy: true, error: null });
    try {
      const result = await operation(host);
      if (disposed || current !== generation)
        throw new Error("Agent controls are no longer available.");
      apply(result);
      return result;
    } catch (error) {
      // Host rejects with sanitized user-facing strings, never raw child output.
      const detail = typeof error === "string" ? `${error} ` : "";
      update({
        status: "error",
        error: `${detail}Could not confirm the operation. Refresh status before other operations; Stop remains available for known agents. Your edits are retained.`,
      });
      throw new Error("Could not confirm the agent operation.");
    } finally {
      update({ busy: false });
    }
  }

  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    save: (id, revision, edit) =>
      run((native) => native.save(id, revision, edit), ready),
    action: (id, action) =>
      run(
        (native) => native.action(id, action),
        ready,
        action === "stop" && canStopAgent(state, id),
      ),
    previewImport: (source) =>
      run(
        (native) => native.previewImport(source),
        () => {},
      ),
    commitImport: (token, ids) =>
      run((native) => native.commitImport(token, ids), ready),
    dispose() {
      disposed = true;
      generation++;
      listeners.clear();
    },
  };
}
