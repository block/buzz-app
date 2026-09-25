import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { RelayData } from "../relay/service";
import { agentDraft, type AgentDraft } from "../../bundled/agents/agent-edit";
import { AgentEditor } from "../../bundled/agents/AgentEditor";
import type { AgentControl, AgentView } from "./control";
import type { AgentManagementRequest } from "./management-request";

export function AgentManagementNotice({
  relay,
  control,
}: {
  relay: RelayData;
  control: AgentControl;
}) {
  const connection = useSyncExternalStore(
    relay.subscribe,
    relay.snapshot,
    relay.snapshot,
  );
  const controlState = useSyncExternalStore(
    control.subscribe,
    control.snapshot,
    control.snapshot,
  );
  const channelList = useSyncExternalStore(
    connection.session.channels.subscribeList,
    connection.session.channels.list,
    connection.session.channels.list,
  );
  const [request, setRequest] = useState<{
    agent: string;
    value: AgentManagementRequest;
  } | null>(null);
  useEffect(() => {
    if (connection.status !== "ready") return;
    const release = connection.session.agentActivity.activate();
    const unsubscribe = connection.session.agentManagement.subscribe(
      (agent, value) => {
        if (request) return;
        const channel = channelList.channels.find(
          (candidate) => candidate.id === value.request.channelId,
        );
        if (!channel?.members?.includes(agent)) return;
        setRequest({ agent, value });
      },
    );
    return () => {
      unsubscribe();
      release();
    };
  }, [channelList, connection, request]);
  useEffect(() => {
    if (request) void control.refresh();
  }, [control, request]);
  const matches = useMemo(() => {
    if (request?.value.action !== "update") return [];
    const target = request.value.request.agentName.trim().toLocaleLowerCase();
    return (controlState.data?.agents ?? []).filter(
      (agent) => agent.name.trim().toLocaleLowerCase() === target,
    );
  }, [controlState.data?.agents, request]);
  if (!request) return null;
  const dismiss = () => setRequest(null);
  if (request.value.action === "create") {
    return (
      <ToastNotice
        title="Agent requested a new agent"
        description="Creation drafts are not supported in buzz-app yet."
        onDismiss={dismiss}
      />
    );
  }
  const agent = matches.length === 1 ? matches[0] : undefined;
  if (!agent) {
    return (
      <ToastNotice
        title="Agent update needs attention"
        description={
          matches.length > 1
            ? "More than one personal agent has that name. Rename one, then ask again."
            : `No personal agent named ${request.value.request.agentName} was found.`
        }
        onDismiss={dismiss}
      />
    );
  }
  const initial = requestedDraft(agent, request.value);
  return (
    <AgentEditor
      agent={agent}
      control={control}
      state={controlState}
      initialDraft={initial}
      notice="Requested by an agent. Review every field before saving."
      onClose={dismiss}
    />
  );
}

export function requestedDraft(
  agent: AgentView,
  request: Extract<AgentManagementRequest, { action: "update" }>,
): AgentDraft {
  const current = agentDraft(agent);
  const changes = request.request;
  return {
    ...current,
    name: changes.displayName ?? current.name,
    systemPrompt: changes.systemPrompt ?? current.systemPrompt,
    command: changes.runtime ?? current.command,
    provider: changes.provider ?? current.provider,
    model: changes.model ?? current.model,
  };
}
