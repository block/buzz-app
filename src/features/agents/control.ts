/** Native-owned configuration and process evidence; never a relay-session capability. */
// Keep injection reachable from the generated author contract, not host construction.
import type {} from "@deepseek-ai/cordis";
import { communityRequest } from "../communities/api";
import { relayOrigin } from "../communities/destination";
import { createAgentModels, type AgentModels, type ModelHost } from "./models";
declare module "@deepseek-ai/cordis" {
  interface Context {
    agentControl: AgentControl;
  }
}
export type AgentAction = "start" | "stop" | "restart";
export type ImportSource = "installed" | "development";
/** Native-redacted saved-versus-running difference; raw values never cross IPC. */
export type RestartChange =
  | { kind: "value"; before: unknown; after: unknown }
  | { kind: "text"; beforeChars: number | null; afterChars: number | null }
  | { kind: "masked"; before: string | null; after: string | null }
  | { kind: "added" }
  | { kind: "removed" };
export interface RestartDiffEntry {
  field: string;
  change: RestartChange;
}
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
    databricks?: { host: string; filter: string } | null;
  };
  revision: number;
  runningRevision: number | null;
  enabled: boolean;
  status: "stopped" | "starting" | "running" | "stopping" | "failed";
  error: string | null;
  diagnostics: string[];
  profilePending?: boolean;
  /** Launch restore preference; saving it never changes the running process. */
  startOnAppLaunch: boolean;
  /** Effective response policy for the next start; null when it is invalid. */
  respondTo: "owner-only" | "allowlist" | "anyone" | null;
  /** Imported provider backend id; null for local agents. */
  backend: string | null;
  acpCommand: string | null;
  mcpCommand: string | null;
  /** Model/provider the next start uses: saved selectors, build defaults, then
   * the worker's model/provider environment overrides. Null when none applies. */
  launchModel: string | null;
  launchProvider: string | null;
  /** Empty unless a running process was started with different saved settings. */
  restartDiff: RestartDiffEntry[];
}
export interface ControlSnapshot {
  agents: AgentView[];
  runtimeAvailable: boolean;
  /** Native-owned editing suggestions, not installation or execution evidence.
   * Optional so an older running native host retains editable custom values. */
  harnessOptions?: {
    command: string;
    label: string;
    available?: boolean;
    defaultArgs?: string[];
    providers: { value: string; label: string }[];
  }[];
  /** False while native credential/import acceptance is outstanding. */
  importAvailable?: boolean;
  createAvailable?: boolean;
  defaultWorkspace?: string;
  runtimeMessage?: string | null;
  databricksDefaults?: { host: string; filter: string };
  agentDefaults?: { provider: string; model: string; ownerOnly: boolean };
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
  models?: ModelHost;
  prepareCreate?(
    requestId: string,
    destination: string,
    owner: string,
  ): Promise<{ id: string; pubkey: string }>;
  commitCreate?(
    requestId: string,
    edit: AgentEdit,
    auth: string,
  ): Promise<ControlSnapshot>;
  publishProfile?(id: string): Promise<ControlSnapshot>;
  setStartOnAppLaunch?(id: string, enabled: boolean): Promise<ControlSnapshot>;
  snapshot(): Promise<ControlSnapshot>;
  save(
    id: string,
    expectedRevision: number,
    edit: AgentEdit,
  ): Promise<ControlSnapshot>;
  action(
    id: string,
    action: AgentAction,
    replayFloor?: number,
  ): Promise<ControlSnapshot>;
  previewImport(
    source: ImportSource,
    destination: string,
  ): Promise<AgentImportPreview>;
  commitImport(token: string, ids: string[]): Promise<ControlSnapshot>;
}
export interface AgentControlState {
  status: "idle" | "loading" | "ready" | "error" | "unavailable";
  data: ControlSnapshot | null;
  busy: boolean;
  /** A credential wait may be interrupted only by explicit Stop. */
  pendingLaunch?: string | null;
  pendingCredentialWrite?: boolean;
  mentionError?: string | null;
  stopping?: boolean;
  error: string | null;
}
export interface AgentControl {
  models?: AgentModels;
  create?(
    requestId: string,
    destination: string,
    owner: string,
    edit: AgentEdit,
  ): Promise<AgentView>;
  publishProfile?(id: string): Promise<ControlSnapshot>;
  setStartOnAppLaunch?(id: string, enabled: boolean): Promise<ControlSnapshot>;
  snapshot(): AgentControlState;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  save: AgentControlHost["save"];
  action: AgentControlHost["action"];
  previewImport: AgentControlHost["previewImport"];
  commitImport: AgentControlHost["commitImport"];
  prepareMention(
    pubkeys: readonly string[],
    relayUrl: string,
    replayFloor: number,
    signal: AbortSignal,
  ): (earliestPending?: number) => Promise<void>;
  dismissMentionError(): void;
}

/** Shared launch availability; Stop intentionally has its own recovery policy. */
export function agentLaunchBlock(
  state: AgentControlState,
  agent: AgentView,
): string | null {
  if (state.status !== "ready") return "Refresh status before starting.";
  if (state.busy) return "Waiting for the current operation.";
  if (!state.data?.runtimeAvailable)
    return (
      state.data?.runtimeMessage || "The bundled agent runtime is unavailable."
    );
  if (agent.status === "starting" || agent.status === "stopping")
    return "Waiting for the process transition.";
  return null;
}

/** Stop is recovery, not a launch: stale stopped/disabled evidence cannot veto it. */
export function canStopAgent(state: AgentControlState, id: string): boolean {
  if (
    state.busy &&
    ((!state.pendingLaunch && !state.pendingCredentialWrite) || state.stopping)
  )
    return false;
  const agent = state.data?.agents.find((candidate) => candidate.id === id);
  return (
    !!agent &&
    (state.status === "error" ||
      (state.status === "ready" &&
        (state.pendingLaunch === id ||
          agent.enabled ||
          agent.status !== "stopped")))
  );
}

export const agentControlUnavailable =
  "Local agent controls require the desktop app. This browser cannot run or manage agent processes.";

/** Own once at app composition. Disposing this projection never stops native agents. */
export function createAgentControl(
  host: AgentControlHost | null,
): AgentControl & { dispose(): void } {
  const models = createAgentModels(host?.models);
  let state: AgentControlState = {
    status: host ? "idle" : "unavailable",
    data: null,
    busy: false,
    error: host ? null : agentControlUnavailable,
  };
  const listeners = new Set<() => void>();
  let disposed = false;
  let generation = 0;
  let stopped = 0;
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
      .then(async () => {
        // Only read-only native startup/contention failures are transient. Keep
        // the coalesced read loading for up to twenty 250ms waits, not a UI error.
        for (let attempt = 0; !disposed && current === generation; attempt++) {
          try {
            return await host.snapshot();
          } catch (error) {
            if (disposed || current !== generation) return;
            if (
              attempt === 20 ||
              (error !== "Agent runtime is initializing; retry shortly" &&
                error !== "Another native agent operation is in progress")
            )
              throw error;
            await new Promise<void>((resolve) => setTimeout(resolve, 250));
          }
        }
      })
      .then(
        (data) => {
          if (data && current === generation) ready(data);
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
    launchId?: string,
    credentialWrite = false,
  ): Promise<T> {
    if (!host || disposed) throw new Error(agentControlUnavailable);
    if (state.busy && !allowRecoveryStop)
      throw new Error("Another agent operation is in progress.");
    if (state.status !== "ready" && !allowRecoveryStop)
      throw new Error("Refresh local agents before trying again.");
    const current = ++generation;
    // A pre-write read must not overwrite this command, even when it completes later.
    read = null;
    update({
      busy: true,
      error: null,
      ...(launchId ? { pendingLaunch: launchId } : {}),
      ...(credentialWrite ? { pendingCredentialWrite: true } : {}),
      stopping: allowRecoveryStop,
    });
    try {
      const result = await operation(host);
      if (disposed || current !== generation)
        throw new Error("Agent controls are no longer available.");
      apply(result);
      return result;
    } catch (error) {
      // Host rejects with sanitized user-facing strings, never raw child output.
      const detail = typeof error === "string" ? `${error} ` : "";
      if (current === generation)
        update({
          status: "error",
          error: `${detail}Could not confirm the operation. Refresh status before other operations; Stop remains available for known agents. Your edits are retained.`,
        });
      throw new Error("Could not confirm the agent operation.");
    } finally {
      // A superseded credential wait still owns its busy lane, but never the
      // newer Stop's result/error. Credential writes may commit; refresh recovers them.
      if (!disposed && (launchId || credentialWrite)) {
        update({
          ...(launchId
            ? { pendingLaunch: null }
            : { pendingCredentialWrite: false }),
          busy: !!state.stopping,
        });
      } else if (current === generation) {
        update({
          stopping: false,
          busy: !!(state.pendingLaunch || state.pendingCredentialWrite),
        });
      }
    }
  }

  const action: AgentControlHost["action"] = (id, command, replayFloor) => {
    if (command === "stop") stopped++;
    return run(
      (native) =>
        native.action(
          id,
          command,
          ...(replayFloor === undefined ? [] : [replayFloor]),
        ),
      ready,
      command === "stop" && canStopAgent(state, id),
      command === "stop" ? undefined : id,
    );
  };
  return {
    models,
    ...(host?.prepareCreate && host.commitCreate
      ? {
          create: async (
            requestId: string,
            destination: string,
            owner: string,
            edit: AgentEdit,
          ) => {
            let id = "";
            const data = await run(
              async (native) => {
                if (!native.prepareCreate || !native.commitCreate)
                  throw new Error("Agent creation is unavailable.");
                const prepared = await native.prepareCreate(
                  requestId,
                  destination,
                  owner,
                );
                id = prepared.id;
                const result = await communityRequest<{ auth: string[] }>(
                  destination,
                  "authorize-agent",
                  { pubkey: prepared.pubkey, owner },
                );
                return native.commitCreate(
                  requestId,
                  edit,
                  JSON.stringify(result.auth),
                );
              },
              ready,
              false,
              undefined,
              true,
            );
            const agent = data.agents.find((agent) => agent.id === id);
            if (!agent)
              throw new Error(
                "Creation was not confirmed; refresh agents before trying again.",
              );
            return agent;
          },
        }
      : {}),
    ...(host?.publishProfile
      ? {
          publishProfile: (id: string) =>
            run(
              (native) => {
                if (!native.publishProfile)
                  throw new Error("Profile publication is unavailable.");
                return native.publishProfile(id);
              },
              ready,
              false,
              undefined,
              true,
            ),
        }
      : {}),
    ...(host?.setStartOnAppLaunch
      ? {
          setStartOnAppLaunch: (id: string, enabled: boolean) =>
            run((native) => {
              if (!native.setStartOnAppLaunch)
                throw new Error("Startup preference is unavailable.");
              return native.setStartOnAppLaunch(id, enabled);
            }, ready),
        }
      : {}),
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
    action,
    dismissMentionError: () => update({ mentionError: null }),
    prepareMention(pubkeys, relayUrl, replayFloor, signal) {
      const beforeStop = stopped;
      return async (earliestPending = replayFloor) => {
        if (!host || disposed || signal.aborted || !pubkeys.length) return;
        const valid = () =>
          !disposed && !signal.aborted && stopped === beforeStop;
        await refresh();
        if (!valid()) return;
        if (state.status !== "ready") {
          update({
            mentionError:
              "Message sent, but local agents could not be read. Open Agents to retry.",
          });
          return;
        }
        const agents =
          state.data?.agents.filter(
            (agent) =>
              pubkeys.includes(agent.pubkey) &&
              relayOrigin(agent.relayUrl) === relayOrigin(relayUrl),
          ) ?? [];
        const failures: string[] = [];
        for (const agent of agents) {
          if (!valid()) return;
          if (agent.status === "running" || state.pendingLaunch === agent.id)
            continue;
          try {
            const result = await action(
              agent.id,
              "start",
              Math.min(replayFloor, earliestPending),
            );
            if (!valid()) return;
            const started = result.agents.find((item) => item.id === agent.id);
            if (started?.status !== "running")
              failures.push(
                `${agent.name} could not start. ${started?.error ?? "Open Agents to check its status."}`,
              );
          } catch {
            // Do not retry uncertain writes or bypass the existing busy/fresh-read gate.
            // Later recipients still get an explicit outcome, not silent omission.
            if (!valid()) return;
            failures.push(
              `${agent.name} could not start. ${state.error ?? "Open Agents to retry."}`,
            );
          }
        }
        if (valid() && failures.length)
          update({ mentionError: `Message sent, but ${failures.join(" ")}` });
      };
    },
    previewImport: (source, destination) =>
      run(
        (native) => native.previewImport(source, destination),
        () => {},
      ),
    commitImport: (token, ids) =>
      run(
        (native) => native.commitImport(token, ids),
        ready,
        false,
        undefined,
        true,
      ),
    dispose() {
      disposed = true;
      models.dispose();
      generation++;
      listeners.clear();
    },
  };
}
