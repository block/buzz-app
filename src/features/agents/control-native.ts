import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import {
  createAgentControl,
  type AgentControlHost,
  type AgentWorkspaceHost,
} from "./control";

type ExecEvent =
  | { type: "output"; text: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

/** Native rejects with a sanitized reason; the agent's function reads it. */
const call = <T>(command: string, args: Record<string, unknown>) =>
  invoke<T>(command, args).catch((problem) => {
    throw new Error(
      typeof problem === "string" ? problem : "Workspace call failed",
    );
  });
const workspace: AgentWorkspaceHost = {
  read: (id, path) => call("agent_workspace_read", { id, path }),
  write: (id, path, content) =>
    call("agent_workspace_write", { id, path, content }),
  list: (id, path) => call("agent_workspace_list", { id, path }),
  async exec(id, command, { timeoutMs, signal, onData } = {}) {
    signal?.throwIfAborted();
    const execId = crypto.randomUUID();
    const stop = () =>
      void invoke("agent_workspace_exec_cancel", { execId }).catch(() => {});
    const events = new Channel<ExecEvent>();
    // The final event can arrive after the call itself has resolved.
    const outcome = new Promise<Exclude<ExecEvent, { type: "output" }>>(
      (resolve) => {
        events.onmessage = (event) => {
          if (event.type === "output") onData?.(event.text);
          else resolve(event);
        };
      },
    );
    signal?.addEventListener("abort", stop, { once: true });
    try {
      await call("agent_workspace_exec", {
        id,
        execId,
        command,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        onEvent: events,
      });
      const end = await outcome;
      signal?.throwIfAborted();
      if (end.type === "exit") return end.code;
      throw new Error(end.message);
    } finally {
      signal?.removeEventListener("abort", stop);
    }
  },
};

export function nativeAgentControlHost(): AgentControlHost | null {
  if (!isTauri()) return null;
  return {
    models: {
      begin: () => invoke("agent_models_begin"),
      run: (ticket, request) => invoke("agent_models_run", { ticket, request }),
      cancel: (ticket) => invoke("agent_models_cancel", { ticket }),
    },
    prepareCreate: (requestId, destination, owner) =>
      invoke("agent_control_create_prepare", { requestId, destination, owner }),
    commitCreate: (requestId, edit, auth) =>
      invoke("agent_control_create_commit", { requestId, edit, auth }),
    publishProfile: (id) => invoke("agent_control_creation_profile", { id }),
    publishAs: (id, event) => invoke("agent_identity_publish", { id, event }),
    secret: (id, name) => invoke("agent_identity_secret", { id, name }),
    workspace,
    setStartOnAppLaunch: (id, enabled) =>
      invoke("agent_control_start_on_app_launch", { id, enabled }),
    snapshot: () => invoke("agent_control_snapshot"),
    readLog: async ({ id, pubkey, relayUrl, authorize }) => {
      const nonce = await invoke<string>("agent_control_log_challenge", {
        id,
        pubkey,
        relayUrl,
      });
      const signature = await authorize({ id, pubkey, relayUrl }, nonce);
      return invoke<string>("agent_control_read_log", {
        id,
        pubkey,
        relayUrl,
        nonce,
        signature,
      });
    },
    installPi: () => invoke("pi_install"),
    save: (id, expectedRevision, edit) =>
      invoke("agent_control_save", { id, expectedRevision, edit }),
    saveDefaults: (edit) => invoke("agent_control_save_defaults", { edit }),
    delete: (id, expectedRevision) =>
      invoke("agent_control_delete", { id, expectedRevision }),
    attachMention: (id, expectedRevision, replayFloor) =>
      invoke("agent_control_attach_mention", {
        id,
        expectedRevision,
        replayFloor,
      }),
    action: (id, action, replayFloor) =>
      invoke("agent_control_action", {
        id,
        action,
        ...(replayFloor === undefined ? {} : { replayFloor }),
      }),
    configureHere: (id, resolution) =>
      invoke("agent_control_use_here", { id, resolution }),
    localCloneSettings: (id) =>
      invoke("agent_control_local_clone_settings", { id }),
    cloneSettings: (source, pubkey) =>
      invoke("agent_control_clone_settings", { source, pubkey }),
    previewImport: (source, destination) =>
      invoke("agent_control_import_preview", { source, destination }),
    commitImport: (token, ids) =>
      invoke("agent_control_import_commit", { token, ids }),
  };
}

/** Composition owns this, not the Agents page or selected community. */
export function createNativeAgentControl() {
  return createAgentControl(nativeAgentControlHost());
}
