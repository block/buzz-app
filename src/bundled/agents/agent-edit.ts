import type { AgentEdit, AgentView } from "../../features/agents/control";

export interface AgentDraft {
  revision: number;
  name: string;
  systemPrompt: string;
  workspace: string;
  command: string;
  args: string;
  model: string;
  provider: string;
  environment: Record<string, string | null>;
  databricks?: { host: string; filter: string } | null;
}
export function isGoose(command: string): boolean {
  return command.replaceAll("\\", "/").split("/").at(-1) === "goose";
}
export function agentDraft(agent: AgentView): AgentDraft {
  const databricks = agent.harness.databricks;
  return {
    revision: agent.revision,
    name: agent.name,
    systemPrompt: agent.systemPrompt,
    workspace: agent.workspace,
    command: agent.harness.command,
    args: JSON.stringify(agent.harness.args, null, 2),
    model: agent.harness.model,
    provider: agent.harness.provider,
    environment: {},
    ...(databricks ? { databricks: { ...databricks } } : {}),
  };
}
export function agentEdit(
  draft: AgentDraft,
  modelDiscovery = false,
): AgentEdit {
  if (!modelDiscovery && !draft.name.trim())
    throw new Error("Enter an agent name.");
  if (!draft.command.trim()) throw new Error("Enter a harness executable.");
  if (!modelDiscovery && !draft.workspace.trim())
    throw new Error("Enter a workspace path.");
  let args: unknown;
  try {
    args = JSON.parse(draft.args);
  } catch {
    throw new Error("Arguments must be a JSON array of strings.");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("Arguments must be a JSON array of strings.");
  }
  if (args.some((arg) => arg === "" || arg.includes(","))) {
    throw new Error(
      "ACP arguments must be nonempty and cannot contain commas.",
    );
  }
  return {
    name: draft.name,
    systemPrompt: draft.systemPrompt,
    workspace: draft.workspace,
    harness: {
      command: draft.command,
      args,
      model: draft.model,
      provider: draft.provider,
      ...(draft.databricks ? { databricks: { ...draft.databricks } } : {}),
    },
    environment: { ...draft.environment },
  };
}
export function agentProcessLabel(agent: AgentView): string {
  switch (agent.status) {
    case "running":
      return "Process running · relay readiness unverified";
    case "starting":
      return "Starting process";
    case "stopping":
      return "Stopping process";
    case "failed":
      return "Process failed";
    case "stopped":
      return "Process stopped";
  }
}
