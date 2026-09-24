// Block-hosted community accounts through the development broker's /api/builderlab routes.
export const HOST_SUFFIX = "communities.buzz.xyz";
export const LIMIT = 5;
export const VALID_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type Account = { email?: string; name?: string; expiresAt: string };
export type ApiError = {
  code?: string;
  message?: string;
  setup_needed?: boolean;
};
export type Identity = { npub?: string; pubkey_hex?: string };
export type Community = {
  id?: string;
  name?: string;
  slug?: string;
  normalized_host?: string;
  archived_at?: string | null;
};
export type Reply = {
  error?: ApiError;
  correlation_id?: string;
  identity?: Identity;
  communities?: Community[];
  community?: Community;
  available?: boolean;
};

async function send<T>(
  action: string,
  body?: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/builderlab/${action}`, {
    method: action === "auth" ? "GET" : "POST",
    ...(action === "auth"
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
        }),
    ...(signal ? { signal } : {}),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      value.error ?? `Builderlab request failed (${response.status})`,
    );
  return value;
}
/** The host has no development broker, so Builderlab sign-in cannot work here. */
export class Unsupported extends Error {}
export async function getAuth(): Promise<Account | null> {
  const response = await fetch("/api/builderlab/auth");
  const value = await response.json().catch(() => undefined);
  const auth = value?.auth;
  if (
    response.ok &&
    value &&
    "auth" in value &&
    (auth === null || typeof auth?.expiresAt === "string")
  )
    return auth;
  // A missing route or an app-shell page means no broker answered.
  if (response.ok || response.status === 404)
    throw new Unsupported(
      "Hosted communities need the Buzz development broker and are unavailable in this build.",
    );
  throw new Error(
    value?.error ?? `Builderlab request failed (${response.status})`,
  );
}
export const login = (signal: AbortSignal) =>
  send<{ auth: Account }>("login", {}, signal).then((value) => value.auth);
export const signOut = () => send("sign-out");
export const call = (action: string, body?: Record<string, string>) =>
  send<Reply>(action, body);

const messages: Record<string, string> = {
  missing_mapping: "Connect your Buzz identity before creating a community.",
  invalid_name: "Use lowercase letters, numbers, and hyphens.",
  taken: "That Buzz address is already taken.",
  limit_reached: `You've reached the limit of ${LIMIT} hosted communities.`,
  relay_unavailable: "Community provisioning is temporarily unavailable.",
  identity_already_bound:
    "This Builderlab account is connected to another Buzz identity.",
  pubkey_already_bound:
    "This Buzz identity is connected to another Builderlab account.",
  not_owner: "Only the community owner can do that.",
  transferee_not_registered:
    "That person needs a connected Buzz identity before you can transfer ownership to them.",
};
/** Throws a friendly message for a structured Builderlab error. */
export function check(reply: Reply, fallback: string) {
  if (!reply.error) return reply;
  const message =
    messages[reply.error.code ?? ""] ?? reply.error.message ?? fallback;
  throw new Error(
    reply.correlation_id
      ? `${message} Correlation ID: ${reply.correlation_id}`
      : message,
  );
}
/** The hex key the account is bound to, or null when the server sent no usable key. */
export function boundKey(identity: Identity | null | undefined) {
  const hex = identity?.pubkey_hex?.trim().toLowerCase();
  return hex && /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}
export function relayUrl(community: Community) {
  const host = community.normalized_host?.trim();
  return host ? `wss://${host.replace(/^wss?:\/\//, "")}` : null;
}
