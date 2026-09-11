import { invoke, isTauri } from "@tauri-apps/api/core";
import { createAgentControl, type AgentControlHost } from "./control";

export function nativeAgentControlHost(): AgentControlHost | null {
  if (!isTauri()) return null;
  return {
    snapshot: () => invoke("agent_control_snapshot"),
    save: (id, expectedRevision, edit) =>
      invoke("agent_control_save", { id, expectedRevision, edit }),
    action: (id, action) => invoke("agent_control_action", { id, action }),
    previewImport: (source) =>
      invoke("agent_control_import_preview", { source }),
    commitImport: (token, ids) =>
      invoke("agent_control_import_commit", { token, ids }),
  };
}

/** Composition owns this, not the Agents page or selected community. */
export function createNativeAgentControl() {
  return createAgentControl(nativeAgentControlHost());
}
