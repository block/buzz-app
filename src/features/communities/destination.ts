/** A community is a secure origin, never a credential-bearing URL or an API path. */
export function relayOrigin(input: string): string {
  const value = input.trim();
  if (
    value.length > 2048 ||
    !/^(?:wss|https):\/\/[^/?#\\\s@]+\/?$/i.test(value)
  )
    throw new Error(
      "Enter a wss:// or https:// relay URL without credentials, a path, query, or fragment.",
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "Enter a valid relay URL, such as wss://relay.example.com.",
    );
  }
  url.protocol = "https:";
  if (url.hostname === "." || url.hostname.endsWith(".."))
    throw new Error("Enter a valid relay URL.");
  // DNS treats the final dot as the same host; keep storage and routing identical too.
  if (url.hostname.endsWith(".")) url.hostname = url.hostname.slice(0, -1);
  return url.origin;
}

/**
 * A community address as a person types it: a bare host is assumed to be a
 * secure relay. Saved IDs never take this path, so an alias stays a non-URL.
 */
export function enteredRelayOrigin(input: string): string {
  const value = input.trim();
  return relayOrigin(value.includes("://") ? value : `wss://${value}`);
}

/** A short deployment ID is not a URL and must never acquire a session by itself. */
export function isCommunityAlias(value: string) {
  return (
    /^[a-z][a-z0-9-]{0,63}$/.test(value) &&
    value !== "constructor" &&
    value !== "prototype"
  );
}

/** Optional deployment aliases preserve existing saved IDs without shipping a community list. */
export function parseCommunityAliases(
  raw = "",
): Readonly<Record<string, string>> {
  if (!raw.trim()) return {};
  try {
    const entries: unknown = JSON.parse(raw);
    if (!entries || typeof entries !== "object" || Array.isArray(entries))
      throw new Error();
    const aliases: Record<string, string> = {};
    const origins = new Set<string>();
    for (const [id, value] of Object.entries(entries)) {
      if (!isCommunityAlias(id) || typeof value !== "string") throw new Error();
      const origin = relayOrigin(value);
      if (origins.has(origin)) throw new Error();
      origins.add(origin);
      aliases[id] = origin;
    }
    return Object.freeze(aliases);
  } catch {
    // Do not echo malformed input: an environment value might contain credentials.
    throw new Error(
      "BUZZ_COMMUNITY_ALIASES must be a JSON object of unique alias-to-secure-relay-origin mappings.",
    );
  }
}

const configuredAliases = parseCommunityAliases(
  import.meta.env?.VITE_BUZZ_COMMUNITY_ALIASES,
);

export type RelayPolicy = Readonly<{
  pinned: string;
  allowlist: readonly string[];
  /** `*.suffix` entries as suffix origins: each permits one more DNS label. */
  wildcards: readonly string[];
}>;

export class RelayPolicyError extends Error {}

/** A policy entry is `host` or `host:port`; it matches both `wss://` and `https://`. */
function hostOrigin(entry: unknown): string {
  if (typeof entry !== "string" || /[/*]/.test(entry)) throw new Error();
  return relayOrigin(`https://${entry}`);
}

/** `*.suffix[:port]`: the suffix must be a DNS name of at least two labels, so
 * `*.com` and IP literals such as `*.1.2.3.4` fail. */
function wildcardOrigin(entry: string): string {
  const origin = hostOrigin(entry.slice(2));
  const { hostname } = new URL(origin);
  // WHATWG URL parsing leaves an IPv4 host as four decimal parts.
  if (!hostname.includes(".") || /^(\d+\.){3}\d+$/.test(hostname))
    throw new Error();
  return origin;
}

/** True when `url` is exactly one DNS label under a wildcard suffix origin. */
function matchesWildcard(url: string, wildcard: string) {
  const host = url.slice("https://".length);
  const suffix = `.${wildcard.slice("https://".length)}`;
  const label = host.slice(0, -suffix.length);
  return host.endsWith(suffix) && label !== "" && !label.includes(".");
}

/** Deployment policy is compiled configuration, never a saved user preference. */
export function parseRelayPolicy(raw?: string): RelayPolicy | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      !("pinned" in value) ||
      !("allowlist" in value) ||
      !Array.isArray(value.allowlist)
    )
      throw new Error();
    const pinned = hostOrigin(value.pinned);
    const entries: unknown[] = value.allowlist;
    const wild = (entry: unknown): entry is string =>
      typeof entry === "string" && entry.startsWith("*.");
    const allowlist = entries.filter((entry) => !wild(entry)).map(hostOrigin);
    const wildcards = entries.filter(wild).map(wildcardOrigin);
    return Object.freeze({
      pinned,
      allowlist: Object.freeze([...new Set(allowlist)]),
      wildcards: Object.freeze([...new Set(wildcards)]),
    });
  } catch {
    throw new Error(
      "BUZZ_BUILD_RELAY_POLICY must be a JSON object with a pinned relay host and an allowlist array of relay hosts, each as host, host:port or *.host.",
    );
  }
}

export const configuredRelayPolicy = parseRelayPolicy(
  import.meta.env?.VITE_BUZZ_RELAY_POLICY,
);

export function assertRelayAllowed(
  url: string,
  policy = configuredRelayPolicy,
) {
  if (
    policy &&
    url !== policy.pinned &&
    !policy.allowlist.includes(url) &&
    !policy.wildcards.some((wildcard) => matchesWildcard(url, wildcard))
  )
    throw new RelayPolicyError(
      "This relay is not allowed by this build's relay policy.",
    );
}

export function assertRelayRemovable(
  value: string,
  policy = configuredRelayPolicy,
) {
  if (
    policy &&
    communityDestination(value, configuredAliases, policy).url === policy.pinned
  )
    throw new RelayPolicyError(
      "The pinned relay cannot be removed from this build.",
    );
}

/** The community a saved ID or relay URL names, before the relay policy: a
 * parse, never permission to connect. */
export function resolveCommunity(value: string, aliases = configuredAliases) {
  const legacy = Object.hasOwn(aliases, value) ? aliases[value] : undefined;
  const url = legacy ?? relayOrigin(value);
  const id = Object.keys(aliases).find((key) => aliases[key] === url) ?? url;
  return { id, url, name: new URL(url).host };
}

export function communityDestination(
  value: string,
  aliases = configuredAliases,
  policy = configuredRelayPolicy,
) {
  const destination = resolveCommunity(value, aliases);
  assertRelayAllowed(destination.url, policy);
  return destination;
}

/** The account service's spelling of a destination: `wss://host[:port]` with a
 * lowercase host, no default port and no trailing slash. Aliases resolve to
 * their origin first, so a device-local ID never leaves the device. */
export function relayAddress(value: string) {
  return `wss://${new URL(communityDestination(value).url).host}`;
}
