// Owner/admin community commands. The relay decides authority; this only bounds shape.
const MIN_TTL = 60;
const MAX_TTL = 30 * 24 * 60 * 60;
const MAX_USES = 10_000;
const ROLES = ["admin", "member"];
const KINDS = { add: 9030, remove: 9031, role: 9032 };

/** Normalized `POST /api/invites` body; unknown fields are dropped. */
export function inviteRequest(value) {
  const { ttl_secs: ttl, max_uses: uses = null } = value ?? {};
  if (!Number.isSafeInteger(ttl) || ttl < MIN_TTL || ttl > MAX_TTL)
    throw new Error("Invalid invite expiry");
  if (
    uses !== null &&
    (!Number.isSafeInteger(uses) || uses < 1 || uses > MAX_USES)
  )
    throw new Error("Invalid invite use limit");
  return { ttl_secs: ttl, max_uses: uses };
}

/** Unsigned NIP-43 add/remove/role command for one member. */
export function memberCommand(value, now = Math.floor(Date.now() / 1000)) {
  const { action, pubkey, role } = value ?? {};
  const kind = Object.hasOwn(KINDS, action) ? KINDS[action] : undefined;
  if (!kind || typeof pubkey !== "string" || !/^[0-9a-f]{64}$/.test(pubkey))
    throw new Error("Invalid member change");
  if (action === "remove" ? role !== undefined : !ROLES.includes(role))
    throw new Error("Invalid member role");
  return {
    kind,
    content: "",
    created_at: now,
    tags: [["p", pubkey], ...(role ? [["role", role]] : [])],
  };
}

// Exact relay refusals (buzz-relay relay_admin.rs, ingest.rs, api/invites.rs).
// Anything else, including database/internal text, stays a generic summary.
const REASONS = new Set([
  "invalid: actor not authorized: must be admin or owner",
  "invalid: actor not authorized: must be owner",
  "invalid: actor not authorized: only owner can grant admin role",
  "invalid: actor not authorized: admins can only remove members",
  "invalid: cannot remove yourself",
  "invalid: cannot remove the relay owner",
  "invalid: cannot change your own role",
  "invalid: cannot change the relay owner's role",
  "invalid: cannot set role to owner",
  "blocked: you are banned from this community",
  "only relay owners and admins can create invites",
  "community writes are temporarily unavailable",
]);

/** Relay-authored refusal worth showing verbatim; anything else stays generic. */
export function adminReason(body) {
  const reason = body?.error;
  if (typeof reason !== "string") return undefined;
  return REASONS.has(reason) ||
    /^invalid: member not found: [0-9a-f]{64}$/.test(reason) ||
    /^(?:ttl_secs|max_uses) must be between \d{1,8} and \d{1,8}$/.test(reason)
    ? reason
    : undefined;
}

// Exact invite-claim refusal codes (buzz-relay api/invites.rs claim_invite).
const CLAIM_REASONS = new Set([
  "invite_expired",
  "invite_exhausted",
  "invite_invalid",
]);

/** Exact relay claim refusal code; anything else stays generic. */
export function claimReason(body) {
  const reason = body?.error;
  return CLAIM_REASONS.has(reason) ? reason : undefined;
}
