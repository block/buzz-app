import type { Profile } from "./contracts";
import type {
  VerifiedProfile,
  VerifiedProfileAuthority,
} from "./verified-profile";
import { validVerifiedName } from "./verified-profile";

/**
 * A name as a row shows it, saved on this device so the next session starts
 * with it: what lets a reload's first screens show names without reading
 * them. Display only. It is not a signed event: it is never re-verified, and
 * never stands in for one (`event()`, ownership, editing). The session
 * replaces it as soon as it reads the person's kind 0.
 *
 * Short keys: the mirror holds about ten thousand of these.
 * - `p`: public key. `n`: the name the kind 0 gives (`Profile.name`).
 * - `u`: its handle, `f`: the name is a key fragment, `i`: picture.
 * - `a`: the profile says it is an agent, `o`: the owner its auth tag names.
 * - `v`: a verified name, as `[displayName, username, issuerLabel,
 *   verifiedAt, fullName?]`, shown as cached.
 */
export type SavedName = Readonly<{
  p: string;
  n: string;
  u?: string;
  f?: 1;
  i?: string;
  a?: 1;
  o?: string;
  v?: readonly [string, string, string, number, string?];
}>;

const key = /^[0-9a-f]{64}$/;
/** The longest field a record keeps; anything longer is not a name. */
const FIELD = 2048;

export function savedName(
  pubkey: string,
  profile: Profile | undefined,
  verified: VerifiedProfile | undefined,
): SavedName {
  return {
    p: pubkey,
    n: profile?.name ?? pubkey.slice(0, 10),
    ...(profile?.username ? { u: profile.username } : {}),
    ...(!profile || profile.nameIsFallback ? { f: 1 as const } : {}),
    ...(profile?.picture ? { i: profile.picture } : {}),
    ...(profile?.isAgent ? { a: 1 as const } : {}),
    ...(profile?.ownerPubkey ? { o: profile.ownerPubkey } : {}),
    ...(verified
      ? {
          v:
            verified.fullName !== undefined
              ? ([
                  verified.displayName,
                  verified.username,
                  verified.issuerLabel,
                  verified.verifiedAt,
                  verified.fullName,
                ] as const)
              : ([
                  verified.displayName,
                  verified.username,
                  verified.issuerLabel,
                  verified.verifiedAt,
                ] as const),
        }
      : {}),
  };
}

const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= FIELD;

/** A saved record's profile, and its verified name to resolve once the
 * verified-profile authority is known (`savedVerifiedName`); undefined for
 * anything malformed. */
export function restoredName(
  value: unknown,
): { pubkey: string; profile: Profile; verified?: SavedName["v"] } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const { p, n, u, i, o, v } = record;
  if (typeof p !== "string" || !key.test(p) || !text(n)) return;
  if (
    (u !== undefined && !text(u)) ||
    (i !== undefined && !text(i)) ||
    (o !== undefined && (typeof o !== "string" || !key.test(o)))
  )
    return;
  const profile: Profile = Object.freeze({
    name: n,
    ...(record.f === 1 ? { nameIsFallback: true as const } : {}),
    ...(u !== undefined ? { username: u } : {}),
    ...(record.a === 1 || o !== undefined ? { isAgent: true as const } : {}),
    ...(i !== undefined ? { picture: i } : {}),
    ...(o !== undefined ? { ownerPubkey: o } : {}),
  });
  const verified =
    Array.isArray(v) && verifiedName(v, false)
      ? (Object.freeze([...v]) as unknown as SavedName["v"])
      : undefined;
  return { pubkey: p, profile, ...(verified ? { verified } : {}) };
}

const resolved = new WeakMap<object, VerifiedProfile>();
/** A saved verified name, shown as cached under `authority`. */
export function savedVerifiedName(
  value: NonNullable<SavedName["v"]>,
  authority: VerifiedProfileAuthority,
): VerifiedProfile | undefined {
  const held = resolved.get(value);
  if (held?.multipleIssuers === authority.multipleIssuers) return held;
  const name = verifiedName(value, authority.multipleIssuers);
  if (name) resolved.set(value, name);
  return name || undefined;
}

function verifiedName(
  value: readonly unknown[],
  multipleIssuers: boolean,
): VerifiedProfile | undefined {
  const [displayName, username, issuerLabel, verifiedAt, fullName] = value;
  if (
    value.length > 5 ||
    typeof displayName !== "string" ||
    !validVerifiedName(displayName) ||
    typeof username !== "string" ||
    !/^[a-z0-9._-]{1,64}$/.test(username) ||
    typeof issuerLabel !== "string" ||
    !validVerifiedName(issuerLabel) ||
    typeof verifiedAt !== "number" ||
    !Number.isSafeInteger(verifiedAt) ||
    (fullName !== undefined &&
      (typeof fullName !== "string" || !validVerifiedName(fullName)))
  )
    return;
  return Object.freeze({
    displayName,
    username,
    ...(fullName !== undefined ? { fullName } : {}),
    issuerLabel,
    verifiedAt,
    status: "cached",
    multipleIssuers,
  });
}
