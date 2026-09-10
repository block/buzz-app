import { connectBrokerTransport } from "../relay/transport";
import type { PersonalProfile } from "./service";
export type CommunityInfo = {
  name?: string;
  icon?: string;
  policy: {
    version: string;
    terms_markdown?: string;
    privacy_markdown?: string;
    age_attestation_required: boolean;
  } | null;
};
export async function communityRequest<T>(
  id: string,
  route: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(
    `/api/relay/${encodeURIComponent(id)}/${route}`,
    {
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(25000),
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error ?? `Community request failed (${response.status})`,
    );
  return result as T;
}
export async function inspectProfile(id: string) {
  const transport = await connectBrokerTransport(
    "",
    AbortSignal.timeout(12000),
    id,
  );
  const events = await transport.query(
    [{ kinds: [0], authors: [transport.viewer], limit: 5 }],
    AbortSignal.timeout(12000),
  );
  const event = events
    .filter((e) => e.kind === 0 && e.pubkey === transport.viewer)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
  const parsed: unknown = event ? JSON.parse(event.content) : {};
  const existing: Record<string, unknown> =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const profile: PersonalProfile = {
    name: String(existing.display_name ?? existing.name ?? ""),
    picture: typeof existing.picture === "string" ? existing.picture : "",
  };
  return { existing, profile, exists: !!event };
}
export async function publishProfile(
  id: string,
  profile: PersonalProfile,
  existing: Record<string, unknown>,
) {
  const receipt = await communityRequest<{
    accepted: boolean;
    event_id: string;
    message?: string;
  }>(id, "profile", { ...profile, existing });
  if (!receipt.accepted || !receipt.event_id)
    throw new Error(receipt.message ?? "Profile publication was not confirmed");
}
