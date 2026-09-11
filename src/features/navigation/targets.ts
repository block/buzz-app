import { relayOrigin } from "../communities/destination";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type NavigationScope = Readonly<{
  viewer: string;
  communityOrigin: string;
}>;
export type LocatorScope = Readonly<{ communityOrigin: string }>;
export type OpenTarget = Target<NavigationScope>;
export type SharedTarget = Target<LocatorScope>;
type Target<Scope> =
  | Readonly<{ version: 1; kind: "home" }>
  | Readonly<{ version: 1; kind: "settings"; section?: string }>
  | Readonly<{
      version: 1;
      kind: "page";
      pluginId: string;
      pageId: string;
      /** null explicitly restores Personal space; omission leaves community selection alone. */
      scope?: Scope | null;
      route?: Readonly<{ version: number; params: JsonValue }>;
    }>
  | Readonly<{
      version: 1;
      kind: "conversation";
      scope: Scope;
      channelId: string;
      messageId?: string;
      /** Hint only. Resolve the actual root from verified message evidence. */
      threadRootId?: string;
    }>;

const MAX_BYTES = 8192;
const token = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const hex = /^[a-f0-9]{64}$/i;
const invalid = () => new Error("Invalid or unsupported navigation target");
function record(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid();
  if (Object.getOwnPropertySymbols(value).length) throw invalid();
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!("value" in descriptor) || !descriptor.enumerable) throw invalid();
  }
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalid();
}
function text(value: unknown, pattern = token): string {
  if (typeof value !== "string" || !pattern.test(value)) throw invalid();
  return value;
}
function boundScope(input: unknown): NavigationScope {
  const value = record(input);
  fields(value, ["viewer", "communityOrigin"]);
  if (typeof value.communityOrigin !== "string") throw invalid();
  return Object.freeze({
    viewer: text(value.viewer, hex).toLowerCase(),
    communityOrigin: relayOrigin(value.communityOrigin),
  });
}

/** Copy, bound and sort JSON before retaining plugin-supplied state. No references survive. */
function json(input: unknown, depth = 0, budget = { nodes: 1024 }): JsonValue {
  if (depth > 8 || --budget.nodes < 0) throw invalid();
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "string") {
    if (input.length > MAX_BYTES) throw invalid();
    return input;
  }
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (Array.isArray(input)) {
    if (input.length > 256) throw invalid();
    const result: JsonValue[] = [];
    for (let index = 0; index < input.length; index++) {
      // JSON arrays are dense. Reject holes instead of changing them to null in links.
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor || !("value" in descriptor)) throw invalid();
      result.push(json(descriptor.value, depth + 1, budget));
    }
    return Object.freeze(result);
  }
  const value = record(input);
  const keys = Object.keys(value);
  if (keys.length > 128) throw invalid();
  keys.sort();
  const result: Record<string, JsonValue> = Object.create(null);
  for (const key of keys) {
    if (key.length > 128) throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw invalid();
    result[key] = json(descriptor.value, depth + 1, budget);
  }
  return Object.freeze(result);
}

function parseTarget<S>(
  input: unknown,
  parseScope: (input: unknown) => S,
): Target<S> {
  try {
    const value = record(input);
    if (value.version !== 1) throw invalid();
    let target: Target<S>;
    switch (value.kind) {
      case "home":
        fields(value, ["version", "kind"]);
        target = { version: 1, kind: "home" };
        break;
      case "settings":
        fields(value, ["version", "kind", "section"]);
        target = {
          version: 1,
          kind: "settings",
          ...(value.section !== undefined
            ? { section: text(value.section) }
            : {}),
        };
        break;
      case "page": {
        fields(value, [
          "version",
          "kind",
          "pluginId",
          "pageId",
          "scope",
          "route",
        ]);
        let route: { version: number; params: JsonValue } | undefined;
        if (value.route !== undefined) {
          const raw = record(value.route);
          fields(raw, ["version", "params"]);
          if (!Number.isSafeInteger(raw.version) || (raw.version as number) < 1)
            throw invalid();
          route = Object.freeze({
            version: raw.version as number,
            params: json(raw.params),
          });
        }
        target = {
          version: 1,
          kind: "page",
          pluginId: text(value.pluginId),
          pageId: text(value.pageId),
          ...(value.scope !== undefined
            ? { scope: value.scope === null ? null : parseScope(value.scope) }
            : {}),
          ...(route ? { route } : {}),
        };
        break;
      }
      case "conversation":
        fields(value, [
          "version",
          "kind",
          "scope",
          "channelId",
          "messageId",
          "threadRootId",
        ]);
        if (value.threadRootId !== undefined && value.messageId === undefined)
          throw invalid();
        target = {
          version: 1,
          kind: "conversation",
          scope: parseScope(value.scope),
          channelId: text(
            value.channelId,
            /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/,
          ),
          ...(value.messageId !== undefined
            ? { messageId: text(value.messageId, hex).toLowerCase() }
            : {}),
          ...(value.threadRootId !== undefined
            ? { threadRootId: text(value.threadRootId, hex).toLowerCase() }
            : {}),
        };
        break;
      default:
        throw invalid();
    }
    if (new TextEncoder().encode(JSON.stringify(target)).length > MAX_BYTES)
      throw invalid();
    return Object.freeze(target);
  } catch {
    // Never echo arbitrary input, URL credentials, plugin route data or accessor errors.
    throw invalid();
  }
}

/** All bound ingresses use this parser. A valid address is not authorization. */
export function parseOpenTarget(input: unknown): OpenTarget {
  return parseTarget(input, boundScope);
}
export function parseSharedTarget(input: unknown): SharedTarget {
  return parseTarget(input, (input) => {
    const value = record(input);
    fields(value, ["communityOrigin"]);
    if (typeof value.communityOrigin !== "string") throw invalid();
    return Object.freeze({
      communityOrigin: relayOrigin(value.communityOrigin),
    });
  });
}
/** Bind a copied locator once, when the host admits it for its actual recipient. */
export function bindSharedTarget(
  input: SharedTarget,
  viewer: string,
): OpenTarget {
  const target = parseSharedTarget(input);
  return parseOpenTarget({
    ...target,
    ...("scope" in target && target.scope
      ? { scope: { ...target.scope, viewer } }
      : {}),
  });
}
export function targetKey(target: OpenTarget): string {
  return JSON.stringify(parseOpenTarget(target));
}

/** Copyable links omit the sender's viewer. Receipt payloads use OpenTarget instead. */
export function targetLink(input: OpenTarget): string {
  const target = parseOpenTarget(input);
  const locator = parseSharedTarget({
    ...target,
    ...("scope" in target && target.scope
      ? { scope: { communityOrigin: target.scope.communityOrigin } }
      : {}),
  });
  return `buzz://open?target=${encodeURIComponent(JSON.stringify(locator))}`;
}
export function parseTargetLink(input: string): SharedTarget {
  try {
    if (input.length > MAX_BYTES * 4) throw invalid();
    const url = new URL(input);
    if (
      url.protocol !== "buzz:" ||
      url.hostname !== "open" ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname ||
      url.hash ||
      [...url.searchParams.keys()].length !== 1 ||
      !url.searchParams.has("target")
    )
      throw invalid();
    const raw = url.searchParams.get("target");
    if (raw === null) throw invalid();
    if (new TextEncoder().encode(raw).length > MAX_BYTES) throw invalid();
    return parseSharedTarget(JSON.parse(raw));
  } catch {
    throw invalid();
  }
}
