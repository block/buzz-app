import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { RelayData } from "../relay/service";
import { agentDraft, type AgentDraft } from "../../bundled/agents/agent-edit";
import { AgentEditor } from "../../bundled/agents/AgentEditor";
import type { AgentControl, AgentView } from "./control";
import type { ChannelList } from "../relay/contracts";
import type { AgentManagementRequest } from "./management-request";

export type PendingManagementRequest = {
  agent: string;
  value: AgentManagementRequest;
};
const MANAGEMENT_QUEUE_LIMIT = 200;

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
  const [requests, setRequests] = useState<PendingManagementRequest[]>([]);
  const request = requests[0] ?? null;
  useEffect(() => {
    if (connection.status !== "ready") return;
    const release = connection.session.agentActivity.activate();
    const unsubscribe = connection.session.agentManagement.subscribe(
      (agent, value) => {
        setRequests((pending) =>
          enqueueManagementRequest(pending, { agent, value }),
        );
      },
    );
    return () => {
      unsubscribe();
      release();
    };
  }, [connection]);
  useEffect(() => {
    if (!request) return;
    const authorized = managementRequesterAuthorized(request, channelList);
    if (authorized === false) setRequests((pending) => pending.slice(1));
  }, [channelList, request]);
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
  if (!request || channelList.status !== "ready") return null;
  const dismiss = () => setRequests((pending) => pending.slice(1));
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

export function enqueueManagementRequest(
  pending: readonly PendingManagementRequest[],
  request: PendingManagementRequest,
): PendingManagementRequest[] {
  return [...pending, request].slice(-MANAGEMENT_QUEUE_LIMIT);
}

export function managementRequesterAuthorized(
  request: PendingManagementRequest,
  channels: ChannelList,
): boolean | null {
  if (channels.status !== "ready") return null;
  const channel = channels.channels.find(
    (candidate) => candidate.id === request.value.request.channelId,
  );
  return channel?.members?.includes(request.agent) ?? false;
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
