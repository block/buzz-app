export const AGENT_MANAGEMENT_REQUEST = "agent_management_request" as const;

export type AgentManagementRequest = Readonly<{
  type: typeof AGENT_MANAGEMENT_REQUEST;
  action: "update";
  requestId: string;
  request: Readonly<{
    channelId: string;
    agentName: string;
    displayName?: string;
    systemPrompt?: string;
    runtime?: string;
    provider?: string;
    model?: string;
  }>;
}>;

const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const only = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

/** Parse only the deliberately narrow, no-secret owner-review contract. */
export function parseAgentManagementRequest(
  value: unknown,
): AgentManagementRequest | null {
  const payload = object(value);
  const request = object(payload?.request);
  if (
    !payload ||
    !request ||
    payload.type !== AGENT_MANAGEMENT_REQUEST ||
    !text(payload.requestId)
  )
    return null;
  if (
    payload.action !== "update" ||
    !only(request, [
      "channelId",
      "agentName",
      "displayName",
      "systemPrompt",
      "runtime",
      "provider",
      "model",
    ]) ||
    !text(request.channelId) ||
    !text(request.agentName)
  )
    return null;
  const changes = {
    ...(text(request.displayName) ? { displayName: request.displayName } : {}),
    ...(text(request.systemPrompt)
      ? { systemPrompt: request.systemPrompt }
      : {}),
    ...(text(request.runtime) ? { runtime: request.runtime } : {}),
    ...(text(request.provider) ? { provider: request.provider } : {}),
    ...(text(request.model) ? { model: request.model } : {}),
  };
  if (!Object.keys(changes).length) return null;
  return {
    type: AGENT_MANAGEMENT_REQUEST,
    action: "update",
    requestId: payload.requestId,
    request: {
      channelId: request.channelId,
      agentName: request.agentName,
      ...changes,
    },
  };
}
