import { avatarSource } from "../../shared/avatar-source.ts";
import type { RelayEvent } from "../relay/events.ts";
import type { AgentView } from "./control.ts";
import { harnessKind } from "./harness-presets.ts";

/** NIP-AP agent definition and team-catalog projection kinds. */
export const AGENT_CATALOG_KIND = 30175;
export const TEAM_CATALOG_KIND = 30178;
export const TEAM_CATALOG_VERSION = 1;
const SHARED_TAG = ["shared", "true"] as const;
const MAX_CONTENT_BYTES = 65_535;
const MAX_DISPLAY_NAME_CHARS = 128;
const MAX_SYSTEM_PROMPT_BYTES = 64 * 1024;
const MAX_DESCRIPTION_CHARS = 280;
const MAX_TEAM_MEMBERS = 64;
const MAX_TEAM_NAME_BYTES = 256;
const MAX_TEAM_TEXT_BYTES = 4 * 1024;
const MAX_MEMBER_PROMPT_BYTES = 16 * 1024;
const MAX_MEMBER_KEY_BYTES = 128;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_HTTP_AVATAR_BYTES = 2048;
const STOCK_ACP = "buzz-acp";

export type SessionPolicy = "channel" | "thread";
export type RespondTo = "anyone" | "owner-only";

/** The adoptable fields of one shared agent; all other content is ignored. */
export interface CatalogAgent {
  displayName: string;
  systemPrompt: string;
  description?: string;
  avatarUrl?: string;
  runtime?: string;
  model?: string;
  provider?: string;
  respondTo?: RespondTo;
  sessionPolicy: SessionPolicy;
}
export interface CatalogTeamMember extends CatalogAgent {
  memberKey: string;
}
export interface AgentPublication {
  kind: typeof AGENT_CATALOG_KIND;
  eventId: string;
  owner: string;
  d: string;
  createdAt: number;
  agent: CatalogAgent;
}
export interface TeamPublication {
  kind: typeof TEAM_CATALOG_KIND;
  eventId: string;
  owner: string;
  d: string;
  createdAt: number;
  name: string;
  description?: string;
  instructions?: string;
  members: CatalogTeamMember[];
}
export type CatalogPublication = AgentPublication | TeamPublication;

const bytes = (value: string) => new TextEncoder().encode(value).length;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const EMOJI = /\p{Emoji}/u;
const CONTROL = /\p{Cc}/u;

/** NIP-AP visible-text policy: reject concealed, bidi and control characters.
 * Emoji ZWJ sequences and VS16 after an emoji base remain legal. */
export function visibleText(value: string, multiline: boolean): boolean {
  const chars = [...value];
  return chars.every((char, index) => {
    if (multiline && (char === "\n" || char === "\t")) return true;
    if (CONTROL.test(char)) return false;
    if (!DEFAULT_IGNORABLE.test(char)) return true;
    const previous = chars[index - 1] ?? "";
    if (char === "\uFE0F") return EMOJI.test(previous);
    if (char === "\u200D")
      return (
        (PICTOGRAPHIC.test(previous) || previous === "\uFE0F") &&
        PICTOGRAPHIC.test(chars[index + 1] ?? "")
      );
    return false;
  });
}

export function portableAcpCommand(command: string): boolean {
  return (
    command === STOCK_ACP ||
    (command.length <= 255 && /^buzz-[A-Za-z0-9_-]+-acp$/.test(command))
  );
}

/** Only HTTPS artwork travels; inline art would exceed the outbox budget and
 * the reader still renders through the authenticated media path. */
function catalogAvatar(value: unknown): string | undefined {
  const source = avatarSource(value);
  return source?.startsWith("https:") && bytes(source) <= MAX_HTTP_AVATAR_BYTES
    ? source
    : undefined;
}

export function catalogSlug(pubkey: string): string {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error("Invalid agent identity");
  return pubkey;
}

/** Opaque per-team member identity; discloses no local identifier. */
export async function memberKey(id: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`buzz:team-catalog:member-key:v1\0${id}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Field order is the wire order; keys absent here can never leak. */
function persona(agent: AgentView) {
  // The bundled transport is a local path; only its portable alias travels.
  const acp =
    agent.acpCommand
      ?.split(/[\\/]/)
      .at(-1)
      ?.replace(/\.exe$/i, "") ?? STOCK_ACP;
  const runtime = harnessKind(agent.harness.command);
  const avatar = catalogAvatar(agent.picture);
  const model = agent.harness.model.trim();
  const provider = agent.harness.provider.trim();
  return {
    display_name: agent.name,
    system_prompt: agent.systemPrompt,
    ...(portableAcpCommand(acp) ? { acp_command: acp } : {}),
    ...(avatar ? { avatar_url: avatar } : {}),
    ...(runtime ? { runtime } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    // An allowlist would disclose the owner's trusted pubkeys; downgrade it.
    ...(agent.respondTo
      ? {
          respond_to:
            agent.respondTo === "allowlist" ? "owner-only" : agent.respondTo,
        }
      : {}),
    session_policy: agent.sessionPolicy ?? "channel",
  };
}

function checkDefinition(name: string, prompt: string, label = "Agent") {
  if (!name.trim()) throw new Error("Display name is required");
  if ([...name].length > MAX_DISPLAY_NAME_CHARS)
    throw new Error(
      `Display name is too long (${[...name].length} characters, max ${MAX_DISPLAY_NAME_CHARS})`,
    );
  if (bytes(prompt) > MAX_SYSTEM_PROMPT_BYTES)
    throw new Error(
      `${label} instructions are too long (${bytes(prompt)} bytes, max ${MAX_SYSTEM_PROMPT_BYTES})`,
    );
  if (!visibleText(name, false) || !visibleText(prompt, true))
    throw new Error(
      `${label} contains prohibited invisible or formatting characters`,
    );
}

export function agentCatalogContent(agent: AgentView): string {
  checkDefinition(agent.name, agent.systemPrompt);
  const content = JSON.stringify(persona(agent));
  if (bytes(content) > MAX_CONTENT_BYTES)
    throw new Error("Agent definition is too large to share");
  return content;
}

export interface CatalogTeamSource {
  id: string;
  name: string;
  agents: readonly string[];
}

export async function teamCatalogContent(
  team: CatalogTeamSource,
  members: readonly AgentView[],
): Promise<string> {
  const fail = (reason: string) => {
    throw new Error(reason);
  };
  if (!team.name.trim())
    fail("invalid team projection: the team name is empty");
  if (bytes(team.name) > MAX_TEAM_NAME_BYTES)
    fail(
      `team too large to share: the team name is ${bytes(team.name)} bytes (limit ${MAX_TEAM_NAME_BYTES})`,
    );
  if (!visibleText(team.name, false))
    fail(
      "the team name contains prohibited invisible or formatting characters",
    );
  if (team.agents.length > MAX_TEAM_MEMBERS)
    fail(
      `team too large to share: ${team.agents.length} members (limit ${MAX_TEAM_MEMBERS})`,
    );
  const projected = [];
  for (const pubkey of team.agents) {
    const agent = members.find((member) => member.pubkey === pubkey);
    if (!agent) throw new Error(`team member ${pubkey} not found`);
    checkDefinition(agent.name, agent.systemPrompt);
    if (bytes(agent.systemPrompt) > MAX_MEMBER_PROMPT_BYTES)
      fail(
        `team too large to share: the system prompt for '${agent.name}' is ${bytes(agent.systemPrompt)} bytes (limit ${MAX_MEMBER_PROMPT_BYTES})`,
      );
    const { session_policy, ...fields } = persona(agent);
    projected.push({
      member_key: await memberKey(pubkey),
      ...fields,
      // The team schema omits the default boundary.
      ...(session_policy === "thread" ? { session_policy } : {}),
    });
  }
  const content = JSON.stringify({
    v: TEAM_CATALOG_VERSION,
    name: team.name,
    members: projected,
  });
  if (bytes(content) > MAX_CONTENT_BYTES) fail("team too large to share");
  return content;
}

/** NIP-AP writing: a replacement must supersede the head despite clock skew. */
export function catalogCreatedAt(now: number, head?: { created_at: number }) {
  return Math.max(now, (head?.created_at ?? 0) + 1);
}

/** The exact owner-to-self envelope the native signer admits. */
export function catalogTemplate(
  kind: typeof AGENT_CATALOG_KIND | typeof TEAM_CATALOG_KIND,
  d: string,
  content: string,
  shared: boolean,
) {
  return {
    kind,
    content,
    tags: [["d", d], ...(shared ? [[...SHARED_TAG]] : [])],
  };
}

const single = (event: RelayEvent, name: string) => {
  const values = event.tags.filter((tag) => tag[0] === name);
  return values.length === 1 ? values[0] : undefined;
};
export function catalogD(event: RelayEvent): string | undefined {
  const tag = single(event, "d");
  return tag && tag.length >= 2 && tag[1] ? tag[1] : undefined;
}
export function isShared(event: RelayEvent): boolean {
  const [tag, ...extra] = event.tags.filter((tag) => tag[0] === "shared");
  return !!tag && !extra.length && tag.length === 2 && tag[1] === SHARED_TAG[1];
}

/** NIP-33: newest created_at, then lowest id, per (kind, owner, d). The head
 * is claimed before visibility so an unshared head hides older shared ones. */
export function catalogHeads(events: readonly RelayEvent[]) {
  const heads = new Map<string, RelayEvent>();
  for (const event of [...events].sort(
    (a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1),
  )) {
    if (event.kind !== AGENT_CATALOG_KIND && event.kind !== TEAM_CATALOG_KIND)
      continue;
    const d = catalogD(event);
    if (d === undefined) continue;
    const key = `${event.kind}:${event.pubkey}:${d}`;
    if (!heads.has(key)) heads.set(key, event);
  }
  return heads;
}

type Body = Record<string, unknown>;
const optionalText = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : undefined;

function parseAgent(
  body: Body,
  memberPrompt = false,
): CatalogAgent | undefined {
  const name = body.display_name;
  const prompt = body.system_prompt ?? "";
  if (typeof name !== "string" || typeof prompt !== "string") return;
  try {
    checkDefinition(name, prompt);
  } catch {
    return;
  }
  if (memberPrompt && bytes(prompt) > MAX_MEMBER_PROMPT_BYTES) return;
  const description = body.description ?? undefined;
  if (
    description !== undefined &&
    (typeof description !== "string" ||
      [...description].length > MAX_DESCRIPTION_CHARS ||
      !visibleText(description, true))
  )
    return;
  const acp = body.acp_command ?? undefined;
  if (
    acp !== undefined &&
    (typeof acp !== "string" || !portableAcpCommand(acp))
  )
    return;
  const identifiers: Partial<Record<"runtime" | "model" | "provider", string>> =
    {};
  for (const key of ["runtime", "model", "provider"] as const) {
    const value = optionalText(body[key]);
    if (
      value &&
      (bytes(value) > MAX_IDENTIFIER_BYTES || !visibleText(value, false))
    )
      return;
    if (value) identifiers[key] = value;
  }
  const respondTo =
    body.respond_to === "allowlist" || body.respond_to === "owner-only"
      ? "owner-only"
      : body.respond_to === "anyone"
        ? "anyone"
        : undefined;
  const avatarUrl = catalogAvatar(body.avatar_url);
  const shownDescription = optionalText(description);
  return {
    displayName: name,
    systemPrompt: prompt,
    ...(shownDescription ? { description: shownDescription } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...identifiers,
    ...(respondTo ? { respondTo } : {}),
    sessionPolicy: body.session_policy === "thread" ? "thread" : "channel",
  };
}

function object(content: string): Body | undefined {
  try {
    const value: unknown = JSON.parse(content);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Body)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Untrusted boundary: any invalid field rejects the whole publication. */
export function parsePublication(
  event: RelayEvent,
): CatalogPublication | undefined {
  const d = catalogD(event);
  const body = object(event.content);
  if (!d || !body || !isShared(event)) return;
  const base = {
    eventId: event.id,
    owner: event.pubkey,
    d,
    createdAt: event.created_at,
  };
  if (event.kind === AGENT_CATALOG_KIND) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(d)) return;
    const agent = parseAgent(body);
    return agent && { kind: AGENT_CATALOG_KIND, ...base, agent };
  }
  if (
    event.kind !== TEAM_CATALOG_KIND ||
    [...d].length > 64 ||
    /[\s\p{Cc}]/u.test(d)
  )
    return;
  if (body.v !== TEAM_CATALOG_VERSION) return;
  const { name, description, instructions, members } = body;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    bytes(name) > MAX_TEAM_NAME_BYTES ||
    !visibleText(name, false) ||
    !Array.isArray(members) ||
    members.length > MAX_TEAM_MEMBERS
  )
    return;
  for (const [value, max] of [
    [description, MAX_TEAM_TEXT_BYTES],
    [instructions, MAX_MEMBER_PROMPT_BYTES],
  ] as const)
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "string" ||
        bytes(value) > max ||
        !visibleText(value, true))
    )
      return;
  const keys = new Set<string>();
  const parsed: CatalogTeamMember[] = [];
  for (const raw of members) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const member = raw as Body;
    const key = member.member_key;
    if (
      typeof key !== "string" ||
      !key.trim() ||
      bytes(key) > MAX_MEMBER_KEY_BYTES ||
      keys.has(key)
    )
      return;
    keys.add(key);
    const agent = parseAgent(member, true);
    if (!agent) return;
    parsed.push({ ...agent, memberKey: key });
  }
  const shownDescription = optionalText(description);
  const shownInstructions = optionalText(instructions);
  return {
    kind: TEAM_CATALOG_KIND,
    ...base,
    name,
    ...(shownDescription ? { description: shownDescription } : {}),
    ...(shownInstructions ? { instructions: shownInstructions } : {}),
    members: parsed,
  };
}

/** Signer admission, mirrored by the native validator: exactly one `d`, at most
 * one exact `["shared","true"]` and one `client-id`, and no `env_vars` body. */
export function validCatalogEnvelope(event: {
  kind?: unknown;
  content?: unknown;
  tags?: unknown;
  created_at?: unknown;
}): boolean {
  const { kind, content, tags, created_at } = event;
  if (
    (kind !== AGENT_CATALOG_KIND && kind !== TEAM_CATALOG_KIND) ||
    typeof content !== "string" ||
    bytes(content) > MAX_CONTENT_BYTES ||
    !Number.isSafeInteger(created_at) ||
    !Array.isArray(tags)
  )
    return false;
  const count = (name: string) =>
    tags.filter((tag) => Array.isArray(tag) && tag[0] === name).length;
  if (count("d") !== 1 || count("shared") > 1 || count("client-id") > 1)
    return false;
  const tagsOk = tags.every(
    (tag) =>
      Array.isArray(tag) &&
      tag.length === 2 &&
      typeof tag[1] === "string" &&
      (tag[0] === "d"
        ? kind === AGENT_CATALOG_KIND
          ? /^[a-z0-9][a-z0-9_-]{0,63}$/.test(tag[1])
          : !!tag[1] && [...tag[1]].length <= 64 && !/[\s\p{Cc}]/u.test(tag[1])
        : tag[0] === "shared"
          ? tag[1] === "true"
          : tag[0] === "client-id" && tag[1].length <= 128),
  );
  const body = tagsOk ? object(content) : undefined;
  if (!body || "env_vars" in body) return false;
  const name = kind === AGENT_CATALOG_KIND ? body.display_name : body.name;
  return (
    typeof name === "string" &&
    !!name.trim() &&
    (kind === AGENT_CATALOG_KIND || Array.isArray(body.members))
  );
}
