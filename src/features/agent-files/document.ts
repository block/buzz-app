// The agent document: one local agent's whole configuration, without runtime
// state or secrets, as `agent_read` gives it to `buzz agents export` and
// `agent_apply` takes it from `buzz agents import`. The CLI turns it into an
// `AGENT.md` file and back; see docs/agent-files.md in the CLI's repository.
import {
  validateObject,
  type AttentionObject,
  type AttentionValue,
  type EventWatch,
  type TimerWatch,
} from "../agents/attention";
import {
  settingsProblem,
  pickSettings,
  type SettingsSchema,
} from "../agents/agent-config";
import { editableMemberRoles } from "../channel-members/administration-protocol";

export const DOCUMENT_VERSION = 1;

/** An attention object as the document carries it: no `since` on an event
 * watch and no `armed_at` on a timer. */
export type PortableValue =
  | Exclude<AttentionValue, EventWatch | TimerWatch>
  | Omit<EventWatch, "since">
  | Omit<TimerWatch, "armed_at">;

export type ChannelMembership = Readonly<{ channel: string; role: string }>;

export type AgentDocument = Readonly<{
  version: number;
  /** Absent in a document that creates an agent. */
  agent?: Readonly<{ pubkey: string; community?: string; owner?: string }>;
  type: string;
  profile: Readonly<{ name: string; about: string; picture?: string }>;
  /** The persona prompt. */
  instructions: string;
  /** The settings that sync for the agent's type. */
  settings: Readonly<Record<string, string>>;
  attention: Readonly<{ objects: Readonly<Record<string, PortableValue>> }>;
  channels: readonly ChannelMembership[];
}>;

/** What the document is made from: a local agent as the app shows it. */
export type LiveAgent = Readonly<{
  pubkey: string;
  relay: string;
  owner: string;
  type: string;
  name: string;
  about?: string;
  picture?: string;
  config: unknown;
  attention: Readonly<Record<string, AttentionObject>>;
}>;

const PUBKEY = /^[0-9a-f]{64}$/;
const CHANNEL =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Its persona prompt, from its type's config. */
export const instructionsOf = (config: unknown) => {
  const instructions =
    config && typeof config === "object"
      ? (config as { instructions?: unknown }).instructions
      : undefined;
  return typeof instructions === "string" ? instructions : "";
};

/** `value` without its runtime state. */
export function portable(value: AttentionValue): PortableValue {
  if (value.type === "event") {
    const { since: _, ...rest } = value;
    return rest;
  }
  if (value.type === "timer") {
    const { armed_at: _, ...rest } = value;
    return rest;
  }
  return value;
}

export function documentOf(
  agent: LiveAgent,
  schema: SettingsSchema | undefined,
  channels: readonly ChannelMembership[],
): AgentDocument {
  const objects: Record<string, PortableValue> = {};
  for (const [slug, object] of Object.entries(agent.attention))
    objects[slug] = portable(object.value);
  return {
    version: DOCUMENT_VERSION,
    agent: { pubkey: agent.pubkey, community: agent.relay, owner: agent.owner },
    type: agent.type,
    profile: {
      name: agent.name,
      about: agent.about ?? "",
      ...(agent.picture ? { picture: agent.picture } : {}),
    },
    instructions: instructionsOf(agent.config),
    settings:
      schema && agent.config && typeof agent.config === "object"
        ? pickSettings(schema, agent.config)
        : {},
    attention: { objects },
    channels: [...channels].sort((a, b) =>
      a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0,
    ),
  };
}

/** JSON with object keys sorted, so equal documents serialize equally. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Changes whenever the document does. */
export async function revisionOf(document: AgentDocument) {
  const bytes = new TextEncoder().encode(canonical(document));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

class Invalid extends Error {}
const fail = (message: string): never => {
  throw new Invalid(message);
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function closed(
  value: unknown,
  what: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isObject(value)) fail(`${what} must be an object`);
  const object = value as Record<string, unknown>;
  for (const name of Object.keys(object))
    if (!required.includes(name) && !optional.includes(name))
      fail(`Unknown field in ${what}: ${name}`);
  for (const name of required)
    if (!(name in object)) fail(`Missing field in ${what}: ${name}`);
  return object;
}
const text = (value: unknown, what: string) =>
  typeof value === "string" ? value : fail(`${what} must be text`);

/** Parses and checks a document the CLI sent. Throws a message saying what
 * is wrong; attention objects are checked as the app stores them. */
export function parseDocument(json: string): AgentDocument {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("The agent document is not JSON");
  }
  try {
    const doc = closed(
      value,
      "the document",
      [
        "version",
        "type",
        "profile",
        "instructions",
        "settings",
        "attention",
        "channels",
      ],
      ["agent"],
    );
    if (doc.version !== DOCUMENT_VERSION)
      fail(`Unsupported agent document version ${String(doc.version)}`);
    let agent: AgentDocument["agent"];
    if (doc.agent !== undefined) {
      const ref = closed(
        doc.agent,
        "agent",
        ["pubkey"],
        ["community", "owner"],
      );
      if (typeof ref.pubkey !== "string" || !PUBKEY.test(ref.pubkey))
        fail("agent.pubkey must be a hex public key");
      if (ref.community !== undefined) text(ref.community, "agent.community");
      if (ref.owner !== undefined) text(ref.owner, "agent.owner");
      agent = ref as AgentDocument["agent"];
    }
    const type = text(doc.type, "type");
    if (!type.trim()) fail("type is empty");
    const profile = closed(
      doc.profile,
      "profile",
      ["name"],
      ["about", "picture"],
    );
    if (!text(profile.name, "profile.name").trim()) fail("Name the agent");
    if (profile.about !== undefined) text(profile.about, "profile.about");
    if (profile.picture !== undefined) text(profile.picture, "profile.picture");
    const instructions = text(doc.instructions, "instructions");
    if (!isObject(doc.settings)) fail("settings must be an object");
    for (const [name, setting] of Object.entries(
      doc.settings as Record<string, unknown>,
    ))
      text(setting, `settings.${name}`);
    const attention = closed(doc.attention, "attention", ["objects"]);
    if (!isObject(attention.objects))
      fail("attention.objects must be an object");
    const objects = attention.objects as Record<string, unknown>;
    for (const [slug, object] of Object.entries(objects)) {
      if (isObject(object) && ("since" in object || "armed_at" in object))
        fail(`${slug}: runtime state isn't part of the document`);
      // Checked with placeholder runtime state, which apply fills in.
      const problem = validateObject(slug, withRuntime(object, 1));
      if (problem) fail(`${slug}: ${problem}`);
    }
    if (!Array.isArray(doc.channels)) fail("channels must be a list");
    const seen = new Set<string>();
    for (const entry of doc.channels as unknown[]) {
      const membership = closed(entry, "a channel", ["channel", "role"]);
      const channel = text(membership.channel, "channel");
      if (!CHANNEL.test(channel)) fail(`Not a channel ID: ${channel}`);
      if (seen.has(channel)) fail(`Channel ${channel} is listed twice`);
      seen.add(channel);
      text(membership.role, `the role in ${channel}`);
    }
    return {
      version: DOCUMENT_VERSION,
      ...(agent ? { agent } : {}),
      type,
      profile: {
        name: profile.name as string,
        about: (profile.about as string | undefined) ?? "",
        ...(profile.picture ? { picture: profile.picture as string } : {}),
      },
      instructions,
      settings: doc.settings as Record<string, string>,
      attention: { objects: objects as Record<string, PortableValue> },
      channels: doc.channels as ChannelMembership[],
    };
  } catch (error) {
    if (error instanceof Invalid) throw new Error(error.message);
    throw error;
  }
}

/** `value` with runtime state: `since` or `armed_at` at `now`. */
function withRuntime(value: unknown, now: number): unknown {
  if (!isObject(value)) return value;
  if (value.type === "event" && !("since" in value))
    return { ...value, since: now };
  if (value.type === "timer" && !("armed_at" in value))
    return { ...value, armed_at: now };
  return value;
}

/** The change one apply makes. */
export type ApplyPlan = Readonly<{
  /** Field names that change, for the approval prompt and the CLI. */
  changes: readonly string[];
  profile: Readonly<{
    name?: string;
    about?: string | null;
    picture?: string | null;
  }>;
  /** The persona and synced settings, when either changes. */
  config?: Readonly<{ instructions: string; settings: Record<string, string> }>;
  /** Slug to new value, `null` deleting it. */
  attention: Readonly<Record<string, AttentionValue | null>>;
  /** The live objects the attention change replaces or deletes. */
  expected: Readonly<Record<string, AttentionObject>>;
  channels: Readonly<{
    add: readonly ChannelMembership[];
    role: readonly ChannelMembership[];
    remove: readonly string[];
  }>;
}>;

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** What applying `desired` over `live` changes. `live` is absent for a new
 * agent. `now` (Unix seconds) arms new watches and timers. Throws for a
 * change this app can't make. */
export function planApply(
  live: Readonly<{ agent: LiveAgent; document: AgentDocument }> | undefined,
  desired: AgentDocument,
  schema: SettingsSchema | undefined,
  now: number,
  prune: boolean,
): ApplyPlan {
  const before = live?.document;
  const changes: string[] = [];
  if (before && before.type !== desired.type)
    throw new Error(
      `Change the agent's type in Buzz first: it is ${before.type}, and the file says ${desired.type}`,
    );
  if (schema) {
    const problem = settingsProblem(schema, desired.settings);
    if (problem) throw new Error(problem);
  } else if (Object.keys(desired.settings).length)
    throw new Error(`Agents of type ${desired.type} have no synced settings`);
  const profile: {
    name?: string;
    about?: string | null;
    picture?: string | null;
  } = {};
  if (before?.profile.name !== desired.profile.name) {
    profile.name = desired.profile.name;
    changes.push("display_name");
  }
  if ((before?.profile.about ?? "") !== desired.profile.about) {
    profile.about = desired.profile.about || null;
    changes.push("description");
  }
  if (before?.profile.picture !== desired.profile.picture) {
    profile.picture = desired.profile.picture ?? null;
    changes.push("avatar");
  }
  const persona = before?.instructions !== desired.instructions;
  const settings = !same(before?.settings ?? {}, desired.settings);
  if (persona) changes.push("instructions");
  if (settings) changes.push("settings");
  const attention: Record<string, AttentionValue | null> = {};
  const expected: Record<string, AttentionObject> = {};
  const current = live?.agent.attention ?? {};
  for (const [slug, value] of Object.entries(desired.attention.objects)) {
    const object = current[slug];
    if (object && same(portable(object.value), value)) continue;
    // An update keeps the live arming time or cursor; a new object starts now.
    const runtime =
      object?.value.type === "event" && value.type === "event"
        ? { since: object.value.since }
        : object?.value.type === "timer" && value.type === "timer"
          ? { armed_at: object.value.armed_at }
          : undefined;
    attention[slug] = withRuntime(
      { ...value, ...runtime },
      now,
    ) as AttentionValue;
    if (object) expected[slug] = object;
    changes.push(slug);
  }
  for (const [slug, object] of Object.entries(current)) {
    if (slug in desired.attention.objects) continue;
    attention[slug] = null;
    expected[slug] = object;
    changes.push(slug);
  }
  const was = new Map(
    (before?.channels ?? []).map((entry) => [entry.channel, entry.role]),
  );
  const add: ChannelMembership[] = [];
  const role: ChannelMembership[] = [];
  for (const entry of desired.channels) {
    const prior = was.get(entry.channel);
    if (prior === entry.role) continue;
    if (!(editableMemberRoles as readonly string[]).includes(entry.role))
      throw new Error(
        `Buzz can make an agent only ${editableMemberRoles.join(", ")} of a channel, not ${entry.role} of ${entry.channel}`,
      );
    (prior === undefined ? add : role).push(entry);
    changes.push(`channels[${entry.channel}]`);
  }
  const listed = new Set(desired.channels.map((entry) => entry.channel));
  const remove = prune
    ? [...was.keys()].filter((channel) => !listed.has(channel))
    : [];
  for (const channel of remove) changes.push(`channels[${channel}]`);
  return {
    changes,
    profile,
    ...(persona || settings
      ? {
          config: {
            instructions: desired.instructions,
            settings: { ...desired.settings },
          },
        }
      : {}),
    attention,
    expected,
    channels: { add, role, remove },
  };
}
