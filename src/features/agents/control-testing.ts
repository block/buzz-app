import type { AgentControlHost, AgentView, ControlSnapshot } from "./control";

/** Synthetic public identity only; no local library, credentials, relay or child processes. */
export function controlFixture() {
  const agent: AgentView = {
    id: "fixture-agent",
    pubkey: "ab".repeat(32),
    relayUrl: "wss://relay.example.test",
    name: "Fixture agent",
    systemPrompt: "Help with the project.",
    workspace: "/fixture/workspace",
    harness: {
      command: "fixture-acp",
      args: ["--literal", "two words", 'quoted "value"'],
      model: "fixture-model",
      provider: "fixture-provider",
      environmentKeys: ["EXAMPLE_TOKEN"],
    },
    revision: 1,
    runningRevision: 1,
    enabled: true,
    status: "running",
    error: null,
    diagnostics: ["Listener process started; readiness is unverified."],
  };
  const data: ControlSnapshot = { runtimeAvailable: true, agents: [agent] };
  const calls: { action: string; payload?: unknown }[] = [];
  let failSave = false;
  const host: AgentControlHost = {
    async snapshot() {
      calls.push({ action: "snapshot" });
      return structuredClone(data);
    },
    async save(id, expectedRevision, edit) {
      calls.push({ action: "save", payload: { id, expectedRevision, edit } });
      if (failSave) throw "The host could not save settings.";
      if (expectedRevision !== agent.revision)
        throw "Saved settings changed. Refresh before saving.";
      const keys = new Set(agent.harness.environmentKeys);
      for (const [key, value] of Object.entries(edit.environment)) {
        if (value === null) keys.delete(key);
        else keys.add(key);
      }
      Object.assign(agent, {
        name: edit.name,
        systemPrompt: edit.systemPrompt,
        workspace: edit.workspace,
        harness: { ...edit.harness, environmentKeys: [...keys] },
        revision: agent.revision + 1,
      });
      return structuredClone(data);
    },
    async action(id, action) {
      calls.push({ action, payload: { id } });
      agent.enabled = action !== "stop";
      agent.status = action === "stop" ? "stopped" : "running";
      agent.runningRevision = action === "stop" ? null : agent.revision;
      return structuredClone(data);
    },
    async previewImport(source) {
      calls.push({ action: "preview", payload: source });
      return {
        token: "fixture-preview",
        sourcePath: `/fixture/${source}/managed-agents.json`,
        warnings: ["Fixture source only."],
        candidates: [
          {
            id: "second-fixture",
            name: "Fixture agent",
            pubkey: "cd".repeat(32),
            relayUrl: "wss://other.example.test",
          },
        ],
      };
    },
    async commitImport(token, ids) {
      calls.push({ action: "import", payload: { token, ids } });
      data.agents.push({
        ...structuredClone(agent),
        id: "second-fixture",
        pubkey: "cd".repeat(32),
        relayUrl: "wss://other.example.test",
        status: "stopped",
        enabled: false,
        runningRevision: null,
      });
      return structuredClone(data);
    },
  };
  return {
    host,
    agent,
    data,
    calls,
    failSave(value: boolean) {
      failSave = value;
    },
  };
}
