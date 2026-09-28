import { type EventData, newer } from "../relay/events";

/** Public display metadata only: never ownership, execution or permission evidence. */
export type PublicAgentMetadata = Readonly<{
  agentType: string;
  capabilities: readonly string[];
}>;

function object(content: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(content);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Matches base Buzz's managed-agent content deserialization, not admission policy. */
function managedContent(body: Record<string, unknown> | undefined): boolean {
  return (
    !!body &&
    typeof body.name === "string" &&
    Number.isInteger(body.parallelism) &&
    (body.parallelism as number) >= 0 &&
    (body.parallelism as number) <= 0xffffffff &&
    ["owner-only", "allowlist", "anyone"].includes(body.respond_to as string) &&
    [
      "persona_id",
      "system_prompt",
      "model",
      "provider",
      "persona_source_version",
    ].every((key) => body[key] == null || typeof body[key] === "string") &&
    (body.respond_to_allowlist === undefined ||
      strings(body.respond_to_allowlist))
  );
}

/** Input is signature-verified session evidence. The owner must come from the
 * identity's winning NIP-OA profile, never a kind-10100 body or local library. */
export function publicAgentMetadata(
  events: readonly (EventData & { delivery?: string })[],
  pubkey: string,
  verifiedOwner?: string,
): PublicAgentMetadata | undefined {
  const published = events.filter(
    (event) =>
      event.delivery === undefined ||
      event.delivery === "seen" ||
      event.delivery === "accepted",
  );
  const policy = verifiedOwner
    ? published
        .filter(
          (event) =>
            event.kind === 30177 &&
            event.pubkey === verifiedOwner &&
            event.tags.find(([name]) => name === "d")?.[1] === pubkey,
        )
        .reduce<EventData | undefined>(newer, undefined)
    : undefined;
  // A malformed winning owner policy reserves the coordinate: never revive legacy fields.
  if (policy)
    return managedContent(object(policy.content))
      ? { agentType: "agent", capabilities: [] }
      : undefined;
  const latest = published
    .filter((event) => event.kind === 10100 && event.pubkey === pubkey)
    .reduce<EventData | undefined>(newer, undefined);
  if (!latest) return undefined;
  const body = object(latest.content) ?? {};
  // Base's sparse legacy projection defaults the type, but rejects mixed arrays.
  for (const key of ["capabilities", "channels", "channel_ids"])
    if (Array.isArray(body[key]) && !strings(body[key])) return undefined;
  if (body.owner_pubkey != null && typeof body.owner_pubkey !== "string")
    return undefined;
  if (
    body.respond_to != null &&
    !["owner-only", "allowlist", "anyone"].includes(body.respond_to as string)
  )
    return undefined;
  if (
    body.respond_to_allowlist !== undefined &&
    !strings(body.respond_to_allowlist)
  )
    return undefined;
  return {
    agentType: typeof body.agent_type === "string" ? body.agent_type : "agent",
    capabilities: strings(body.capabilities) ? body.capabilities : [],
  };
}
