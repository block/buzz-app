// Block-hosted community accounts through the development broker's /api/builderlab routes.
export const HOST_SUFFIX = "communities.buzz.xyz";
export const LIMIT = 5;
export const VALID_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ACKNOWLEDGEMENT_VERSION = 1;
export const DELETION_PENDING_KEY = "buzz.hosted-community-deletion.v1";

const MAX_RESPONSE_BYTES = 64 * 1024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type Account = {
  email?: string;
  name?: string;
  expiresAt: string;
  capabilities?: { can_delete_buzz_communities?: boolean };
};
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
export type DeletionRequest = {
  community_id: string;
  host: string;
  request_id: string;
  acknowledgement_version: 1;
};
export type PendingDeletion = {
  version: 1;
  owner_pubkey: string;
  backend_origin: string;
  request: DeletionRequest;
};
export type Quota = { used: number; limit: number; canCreate: boolean };
export type Reply = {
  error?: ApiError;
  correlation_id?: string;
  identity?: Identity;
  communities?: Community[];
  community?: Community;
  available?: boolean;
  quota_used?: number;
  quota_limit?: number;
  can_create?: boolean;
  request_id?: string;
  community_id?: string;
  host?: string;
  acknowledgement_version?: number;
  status?: string;
};
type Body = Record<string, string | number>;

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
  invalid_request: "The deletion request is invalid.",
  confirmation_mismatch: "The host confirmation does not match exactly.",
  must_archive: "Archive the community before deleting it.",
  protected_target: "This community cannot be deleted.",
  deletion_conflict:
    "This deletion conflicts with another community lifecycle change.",
  unsupported_acknowledgement_version:
    "This deletion confirmation version is not supported.",
  deletion_aborted:
    "This deletion was aborted. Refresh before starting a new request.",
  acceptance_unknown:
    "Deletion status is unknown. Keep this request and check its status; do not start a new deletion.",
  unknown:
    "The deletion service returned an invalid response. Check deletion status before trying anything else.",
};

export class ApiFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly correlationId?: string,
  ) {
    super(
      correlationId ? `${message} Correlation ID: ${correlationId}` : message,
    );
    this.name = "ApiFailure";
  }
}

async function send<T extends object>(
  action: string,
  body?: Body,
  signal?: AbortSignal,
): Promise<{ status: number; value: T }> {
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
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES)
    throw new Error("Builderlab response was too large");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Builderlab returned an invalid response");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Builderlab returned an invalid response");
  const error = (value as { error?: unknown }).error;
  if (!response.ok && (!error || typeof error !== "object"))
    throw new Error(
      typeof error === "string"
        ? error
        : `Builderlab request failed (${response.status})`,
    );
  return { status: response.status, value: value as T };
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
  if (response.ok || response.status === 404)
    throw new Unsupported(
      "Hosted communities need the Buzz development broker and are unavailable in this build.",
    );
  throw new Error(
    value?.error ?? `Builderlab request failed (${response.status})`,
  );
}
export const login = (signal: AbortSignal) =>
  send<{ auth: Account }>("login", {}, signal).then(({ value }) => value.auth);
export const signOut = () => send("sign-out");
export const call = (action: string, body?: Body) =>
  send<Reply>(action, body).then(({ value }) => value);

/** Throws a friendly message for a structured Builderlab error. */
export function check(reply: Reply, fallback: string) {
  if (!reply.error) return reply;
  const code = reply.error.code ?? "";
  throw new ApiFailure(
    code,
    messages[code] ?? reply.error.message ?? fallback,
    reply.correlation_id,
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

/** Missing or malformed authoritative quota is intentionally not reconstructed. */
export function quota(reply: Reply): Quota | null {
  const { quota_used: used, quota_limit: limit, can_create: canCreate } = reply;
  return Number.isInteger(used) &&
    Number.isInteger(limit) &&
    (used as number) >= 0 &&
    (limit as number) >= 0 &&
    (used as number) <= 2_147_483_647 &&
    (limit as number) <= 2_147_483_647 &&
    typeof canCreate === "boolean"
    ? { used: used as number, limit: limit as number, canCreate }
    : null;
}

function exactKeys(value: object, expected: string[]) {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    keys.length === sorted.length &&
    keys.every((key, index) => key === sorted[index])
  );
}

function validDeletionRequest(value: unknown): value is DeletionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return (
    exactKeys(request, [
      "community_id",
      "host",
      "request_id",
      "acknowledgement_version",
    ]) &&
    typeof request.community_id === "string" &&
    request.community_id.length > 0 &&
    request.community_id.length <= 200 &&
    typeof request.host === "string" &&
    request.host.length > 0 &&
    request.host.length <= 253 &&
    request.host === request.host.trim() &&
    typeof request.request_id === "string" &&
    UUID.test(request.request_id) &&
    request.acknowledgement_version === ACKNOWLEDGEMENT_VERSION
  );
}

export function makePendingDeletion(
  ownerPubkey: string,
  community: Community,
): PendingDeletion {
  if (
    !/^[0-9a-f]{64}$/.test(ownerPubkey) ||
    !community.id ||
    !community.normalized_host
  )
    throw new Error("The community deletion target is incomplete");
  return {
    version: 1,
    owner_pubkey: ownerPubkey,
    backend_origin: window.location.origin,
    request: {
      community_id: community.id,
      host: community.normalized_host,
      request_id: crypto.randomUUID(),
      acknowledgement_version: ACKNOWLEDGEMENT_VERSION,
    },
  };
}

function validPendingDeletion(value: unknown): value is PendingDeletion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pending = value as Record<string, unknown>;
  try {
    return (
      exactKeys(pending, [
        "version",
        "owner_pubkey",
        "backend_origin",
        "request",
      ]) &&
      pending.version === 1 &&
      typeof pending.owner_pubkey === "string" &&
      /^[0-9a-f]{64}$/.test(pending.owner_pubkey) &&
      typeof pending.backend_origin === "string" &&
      pending.backend_origin === new URL(pending.backend_origin).origin &&
      validDeletionRequest(pending.request)
    );
  } catch {
    return false;
  }
}

export function readPendingDeletion(): PendingDeletion | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(DELETION_PENDING_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (validPendingDeletion(value)) return value;
  } catch {
    // Invalid local data is not authority and is discarded below.
  }
  try {
    localStorage.removeItem(DELETION_PENDING_KEY);
  } catch {
    // Invalid local data is never authority; an unavailable store is harmless here.
  }
  return null;
}

export function persistPendingDeletion(pending: PendingDeletion) {
  localStorage.setItem(DELETION_PENDING_KEY, JSON.stringify(pending));
}

export function clearPendingDeletion(expected: PendingDeletion) {
  const current = readPendingDeletion();
  if (current && JSON.stringify(current) === JSON.stringify(expected)) {
    try {
      localStorage.removeItem(DELETION_PENDING_KEY);
    } catch {
      // A retained accepted receipt is safe to reconcile again on reopen.
    }
  }
}

function accepted(reply: Reply, request: DeletionRequest) {
  return (
    reply.status === "accepted" &&
    reply.request_id === request.request_id &&
    reply.community_id === request.community_id &&
    reply.host === request.host &&
    reply.acknowledgement_version === request.acknowledgement_version
  );
}

/** Read-only status check. A missing, malformed, or mismatched receipt stays uncertain. */
export async function checkDeletionStatus(request: DeletionRequest) {
  let response: { status: number; value: Reply };
  try {
    response = await send<Reply>("delete-receipt", request);
  } catch {
    throw new ApiFailure(
      "acceptance_unknown",
      messages.acceptance_unknown as string,
    );
  }
  if (response.value.error?.code === "not_owner")
    throw new ApiFailure(
      "acceptance_unknown",
      messages.acceptance_unknown as string,
      response.value.correlation_id,
    );
  check(response.value, "Could not check deletion status.");
  if (response.status === 202 && accepted(response.value, request))
    return response.value;
  throw new ApiFailure(
    "acceptance_unknown",
    messages.acceptance_unknown as string,
    response.value.correlation_id,
  );
}

/** Sends one admission; ambiguous browser responses reconcile through the read-only route. */
export async function admitDeletion(request: DeletionRequest) {
  try {
    const response = await send<Reply>("delete", request);
    if (response.value.error) {
      if (response.value.error.code !== "unknown")
        check(response.value, "Could not start deletion.");
    } else if (response.status === 202 && accepted(response.value, request)) {
      return response.value;
    }
  } catch (reason) {
    if (reason instanceof ApiFailure) throw reason;
    // Browser-to-broker response loss is ambiguous; reconcile below.
  }
  return checkDeletionStatus(request);
}

export const isAcceptanceUnknown = (reason: unknown) =>
  reason instanceof ApiFailure && reason.code === "acceptance_unknown";
