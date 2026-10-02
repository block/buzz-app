import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { Button } from "../../shared/design-system/ui/Button";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { RelayData } from "../../features/relay/service";
import { agentDraft, harnessKind, type AgentDraft } from "./agent-edit";
import { AgentEditor } from "./AgentEditor";
import type {
  AgentControl,
  AgentView,
  ControlSnapshot,
} from "../../features/agents/control";
import type { ChannelList } from "../../features/relay/contracts";
import type { AgentManagementRequest } from "../../features/agents/management-request";
import { relayOrigin } from "../../features/communities/destination";

export type PendingManagementRequest = {
  agent: string;
  value: AgentManagementRequest;
};
const MANAGEMENT_QUEUE_LIMIT = 200;

export function AgentUpdateReview({
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
  const [refreshedRequestId, setRefreshedRequestId] = useState<string | null>(
    null,
  );
  const request = requests[0] ?? null;
  useEffect(() => {
    if (connection.status !== "ready") return;
    const release = connection.session.agentManagement.activate();
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
    if (authorized === false) {
      setRequests((pending) => pending.slice(1));
      return;
    }
    if (
      authorized !== null ||
      channelList.status !== "ready" ||
      channelList.coverage !== "partial" ||
      !connection.session.channels.resolve
    )
      return;
    let current = true;
    const channelId = request.value.request.channelId;
    void connection.session.channels
      .resolve([channelId])
      .catch(() => {})
      .then(() => {
        if (!current) return;
        const refreshed = connection.session.channels.list();
        if (managementRequesterAuthorized(request, refreshed) !== true)
          setRequests((pending) => pending.slice(1));
      });
    return () => {
      current = false;
    };
  }, [channelList, connection.session.channels, request]);
  useEffect(() => {
    if (request?.value.action !== "update") {
      setRefreshedRequestId(null);
      return;
    }
    const requestId = request.value.requestId;
    setRefreshedRequestId(null);
    let current = true;
    void refreshManagementInventory(control).then((ready) => {
      if (current && ready) setRefreshedRequestId(requestId);
    });
    return () => {
      current = false;
    };
  }, [control, request]);
  const matches = useMemo(() => {
    if (request?.value.action !== "update" || !connection.scope) return [];
    const community = connection.scope.split(":").slice(0, -1).join(":");
    return matchingManagementAgents(
      controlState.data?.agents ?? [],
      request,
      community,
    );
  }, [connection.scope, controlState.data?.agents, request]);
  if (!request || channelList.status !== "ready") return null;
  const dismiss = () => setRequests((pending) => pending.slice(1));
  if (request.value.action === "create") {
    return (
      <ToastNotice
        title="Agent creation needs attention"
        description="Agent-requested creation is not supported yet. Create the agent yourself from Agents."
        onDismiss={dismiss}
      />
    );
  }
  if (
    controlState.status === "error" &&
    refreshedRequestId !== request.value.requestId
  ) {
    return (
      <ToastNotice
        title="Could not load personal agents"
        description="Refresh local agents before reviewing this request."
      >
        <Button
          type="button"
          onClick={() => void refreshManagementInventory(control)}
        >
          Retry
        </Button>
      </ToastNotice>
    );
  }
  if (
    (controlState.status !== "ready" && controlState.status !== "error") ||
    refreshedRequestId !== request.value.requestId
  )
    return null;
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
  const initial = requestedDraft(
    agent,
    request.value,
    controlState.data?.harnessOptions ?? [],
  );
  return (
    <AgentEditor
      key={request.value.requestId}
      agent={agent}
      control={control}
      state={controlState}
      initialDraft={initial}
      notice="Requested by an agent. Review every field before saving."
      onClose={dismiss}
    />
  );
}

export async function refreshManagementInventory(
  control: AgentControl,
): Promise<boolean> {
  await control.refresh();
  return control.snapshot().status === "ready";
}

export function matchingManagementAgents(
  agents: readonly AgentView[],
  request: PendingManagementRequest,
  community: string,
): AgentView[] {
  if (request.value.action !== "update") return [];
  const target = request.value.request.agentName.trim().toLocaleLowerCase();
  const origin = relayOrigin(community);
  return agents.filter((agent) => {
    if (
      agent.configured === false ||
      !agent.relayUrl ||
      agent.name.trim().toLocaleLowerCase() !== target ||
      agent.pubkey !== request.agent
    )
      return false;
    try {
      return relayOrigin(agent.relayUrl) === origin;
    } catch {
      return false;
    }
  });
}

export function enqueueManagementRequest(
  pending: readonly PendingManagementRequest[],
  request: PendingManagementRequest,
): PendingManagementRequest[] {
  const next = [...pending, request];
  if (next.length <= MANAGEMENT_QUEUE_LIMIT) return next;
  const [head] = next;
  if (!head) return [];
  return [head, ...next.slice(-(MANAGEMENT_QUEUE_LIMIT - 1))];
}

export function managementRequesterAuthorized(
  request: PendingManagementRequest,
  channels: ChannelList,
): boolean | null {
  if (channels.status !== "ready") return null;
  const channel = channels.channels.find(
    (candidate) => candidate.id === request.value.request.channelId,
  );
  if (!channel && channels.coverage === "partial") return null;
  return channel?.members?.includes(request.agent) ?? false;
}

export function requestedDraft(
  agent: AgentView,
  request: Extract<AgentManagementRequest, { action: "update" }>,
  harnessOptions: NonNullable<ControlSnapshot["harnessOptions"]>,
): AgentDraft {
  const current = agentDraft(agent);
  const changes = request.request;
  const runtime = changes.runtime
    ? harnessOptions.find((option) => {
        const executable = option.command
          .replaceAll("\\", "/")
          .split("/")
          .at(-1);
        return (
          option.available !== false &&
          (option.command === changes.runtime ||
            executable === changes.runtime ||
            harnessKind(option.command) === changes.runtime)
        );
      })
    : undefined;
  return {
    ...current,
    name: changes.displayName ?? current.name,
    systemPrompt: changes.systemPrompt ?? current.systemPrompt,
    command: runtime?.command ?? changes.runtime ?? current.command,
    args: runtime ? JSON.stringify(runtime.defaultArgs ?? []) : current.args,
    provider: changes.provider ?? current.provider,
    model: changes.model ?? current.model,
  };
}
