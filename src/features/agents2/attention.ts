// An agent's attention configuration in the `agent-attention/v1` format: Interests,
// event watches and timers, each one object at a slug. This module is the format
// only (validation, the filter grammar and event matching), so the same objects can
// later move from local storage to the relay's encrypted addressable events.
import type { EventData } from "../relay/events";

export const ATTENTION_SCHEMA = "agent-attention/v1";

export type Interest = Readonly<{ type: "interest"; instructions: string }>;
export type ClassifierQuestion = Readonly<{
  question: string;
  true?: string;
  false?: string;
  guidance?: string;
  threshold: number;
}>;
export type EventWatch = Readonly<{
  type: "event";
  interest_id: string;
  name?: string;
  enabled: boolean;
  since: number;
  channels: "all" | readonly string[];
  kinds: readonly number[];
  tags?: Readonly<Record<string, readonly string[]>>;
  filter?: string;
  classifier?: Readonly<{
    questions: Readonly<Record<string, ClassifierQuestion>>;
  }>;
}>;
export type TimerWatch = Readonly<{
  type: "timer";
  interest_id: string;
  prompt: string;
  enabled: boolean;
  interval_secs: number;
  armed_at: number;
  max_occurrences: number | null;
  expires_at: number | null;
}>;
export type AttentionValue = Interest | EventWatch | TimerWatch;
export type AttentionObject = Readonly<{
  slug: string;
  value: AttentionValue;
  /** Unix seconds; on the relay this is the event's `created_at`. */
  modifiedAt: number;
}>;

const ID = /^[!-~]{1,64}$/;
const CHANNEL =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const QUESTION = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_INT = 2 ** 53 - 1;
const BODY_LIMIT = 65_535;

export function parseSlug(slug: string) {
  const [, space, id] = /^(interest|watch)\/(.+)$/.exec(slug) ?? [];
  return space && id && ID.test(id)
    ? { space: space as "interest" | "watch", id }
    : undefined;
}
export const interestSlug = (id: string) => `interest/${id}`;
export const watchSlug = (id: string) => `watch/${id}`;

class Invalid extends Error {}
const fail = (message: string): never => {
  throw new Invalid(message);
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function fields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  for (const name of Object.keys(value))
    if (!required.includes(name) && !optional.includes(name))
      fail(`Unknown field: ${name}`);
  for (const name of required)
    if (!(name in value)) fail(`Missing field: ${name}`);
}
const text = (value: unknown, name: string) =>
  typeof value === "string" && !value.includes("\0")
    ? value
    : fail(`${name} must be text`);
const filled = (value: unknown, name: string) =>
  text(value, name).trim() ? (value as string) : fail(`${name} is empty`);
function label(value: unknown, name: string) {
  const result = text(value, name);
  if (
    new TextEncoder().encode(result).length > 256 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the spec excludes them.
    /[\u0000-\u001f\u007f-\u009f]/.test(result)
  )
    fail(`${name} must be a short label`);
  return result;
}
const integer = (value: unknown, name: string, min = 0, max = MAX_INT) =>
  Number.isSafeInteger(value) &&
  (value as number) >= min &&
  (value as number) <= max
    ? (value as number)
    : fail(`${name} must be a whole number from ${min} to ${max}`);
const unique = (values: readonly unknown[]) =>
  new Set(values).size === values.length;

function interestId(value: unknown) {
  return typeof value === "string" && ID.test(value)
    ? value
    : fail("interest_id must be an Interest id");
}

function eventWatch(value: Record<string, unknown>) {
  fields(
    value,
    ["type", "interest_id", "enabled", "since", "channels", "kinds"],
    ["name", "tags", "filter", "classifier"],
  );
  interestId(value.interest_id);
  if (value.name !== undefined) label(value.name, "name");
  if (typeof value.enabled !== "boolean") fail("enabled must be true or false");
  integer(value.since, "since", 1);
  const { channels, kinds, tags, classifier } = value;
  if (channels !== "all")
    if (
      !Array.isArray(channels) ||
      !channels.length ||
      !unique(channels) ||
      channels.some(
        (channel) => typeof channel !== "string" || !CHANNEL.test(channel),
      )
    )
      fail('channels must be "all" or a list of channel ids');
  if (
    !Array.isArray(kinds) ||
    !unique(kinds) ||
    kinds.some(
      (kind) => !Number.isSafeInteger(kind) || kind < 0 || kind > 65_535,
    )
  )
    fail("kinds must be a list of event kinds");
  if (tags !== undefined) {
    if (!isObject(tags) || !Object.keys(tags).length)
      fail("tags must name at least one tag");
    for (const [key, values] of Object.entries(tags as object)) {
      if (!/^[A-Za-z]$/.test(key) || key === "h")
        fail(`Tag ${key} must be one letter other than h`);
      if (!Array.isArray(values) || !values.length)
        fail(`Tag ${key} needs values`);
      for (const item of values as unknown[])
        if (!label(item, `Tag ${key}`)) fail(`Tag ${key} values are empty`);
    }
  }
  if (value.filter !== undefined) compileFilter(text(value.filter, "filter"));
  if (classifier !== undefined) {
    if (!isObject(classifier)) fail("classifier must be an object");
    fields(classifier as Record<string, unknown>, ["questions"]);
    const questions = (classifier as Record<string, unknown>).questions;
    if (!isObject(questions) || !Object.keys(questions).length)
      fail("classifier needs a question");
    for (const [name, question] of Object.entries(questions as object)) {
      if (!QUESTION.test(name) || name === "true" || name === "false")
        fail(`Invalid question name: ${name}`);
      if (!isObject(question)) fail(`Question ${name} must be an object`);
      const q = question as Record<string, unknown>;
      fields(q, ["question", "threshold"], ["true", "false", "guidance"]);
      text(q.question, "question");
      for (const key of ["true", "false", "guidance"])
        if (q[key] !== undefined) text(q[key], key);
      if (
        typeof q.threshold !== "number" ||
        !(q.threshold > 0 && q.threshold < 1)
      )
        fail("threshold must be between 0 and 1");
    }
  }
}

function timer(value: Record<string, unknown>) {
  fields(value, [
    "type",
    "interest_id",
    "prompt",
    "enabled",
    "interval_secs",
    "armed_at",
    "max_occurrences",
    "expires_at",
  ]);
  interestId(value.interest_id);
  filled(value.prompt, "prompt");
  if (typeof value.enabled !== "boolean") fail("enabled must be true or false");
  integer(value.interval_secs, "interval_secs", 1, 31_536_000);
  integer(value.armed_at, "armed_at");
  if (value.max_occurrences !== null)
    integer(value.max_occurrences, "max_occurrences", 1);
  if (value.expires_at !== null) integer(value.expires_at, "expires_at");
}

/** Checks one object on its own, as a reader does. Returns a message, or nothing. */
export function validateObject(
  slug: string,
  value: unknown,
): string | undefined {
  try {
    const parsed = parseSlug(slug) ?? fail(`Invalid slug: ${slug}`);
    if (!isObject(value)) fail("value must be an object");
    const object = value as Record<string, unknown>;
    if (parsed.space === "interest") {
      if (object.type !== "interest")
        fail('An interest/ value has type "interest"');
      fields(object, ["type", "instructions"]);
      filled(object.instructions, "instructions");
    } else if (object.type === "event") eventWatch(object);
    else if (object.type === "timer") timer(object);
    else fail('A watch/ value has type "event" or "timer"');
    const body = JSON.stringify({ schema: ATTENTION_SCHEMA, slug, value });
    if (new TextEncoder().encode(body).length > BODY_LIMIT)
      fail("The object is larger than 65,535 bytes");
    return undefined;
  } catch (error) {
    if (error instanceof Invalid) return error.message;
    throw error;
  }
}

// Filter grammar: predicate := or; or := and ("||" and)*; and := atom ("&&" atom)*;
// atom := "!" atom | "(" predicate ")" | true | false | is_reply
//       | (author | content) "==" string
type Predicate = (event: EventData) => boolean;
const MAX_DEPTH = 32;
export function compileFilter(source: string): Predicate {
  let at = 0;
  const space = () => {
    while (at < source.length && " \t\r\n".includes(source[at] as string)) at++;
  };
  const take = (token: string) => {
    space();
    if (!source.startsWith(token, at)) return false;
    const end = at + token.length;
    // Words must end at a word boundary.
    if (/^[a-z_]+$/.test(token) && /[A-Za-z0-9_]/.test(source[end] ?? ""))
      return false;
    at = end;
    return true;
  };
  const string = () => {
    space();
    if (source[at] !== '"') fail("Expected a string in filter");
    let end = at + 1;
    while (end < source.length && source[end] !== '"')
      end += source[end] === "\\" ? 2 : 1;
    try {
      const value = JSON.parse(source.slice(at, end + 1));
      at = end + 1;
      return value as string;
    } catch {
      return fail("Invalid string in filter");
    }
  };
  const atom = (depth: number): Predicate => {
    if (depth > MAX_DEPTH) fail("Filter is nested too deeply");
    if (take("!")) {
      const inner = atom(depth + 1);
      return (event) => !inner(event);
    }
    if (take("(")) {
      const inner = or(depth + 1);
      if (!take(")")) fail("Expected ) in filter");
      return inner;
    }
    if (take("true")) return () => true;
    if (take("false")) return () => false;
    if (take("is_reply")) return isReply;
    for (const field of ["author", "content"] as const)
      if (take(field)) {
        if (!take("==")) fail("Expected == in filter");
        const expected = string();
        return field === "author"
          ? (event) => event.pubkey === expected
          : (event) => event.content === expected;
      }
    return fail("Unexpected token in filter");
  };
  const and = (depth: number): Predicate => {
    const parts = [atom(depth)];
    while (take("&&")) parts.push(atom(depth));
    return parts.length === 1
      ? (parts[0] as Predicate)
      : (event) => parts.every((part) => part(event));
  };
  const or = (depth: number): Predicate => {
    const parts = [and(depth)];
    while (take("||")) parts.push(and(depth));
    return parts.length === 1
      ? (parts[0] as Predicate)
      : (event) => parts.some((part) => part(event));
  };
  const predicate = or(1);
  space();
  if (at !== source.length) fail("Unexpected text at the end of the filter");
  return predicate;
}
const isReply: Predicate = (event) =>
  event.tags.some(
    (tag) =>
      tag[0] === "e" &&
      (tag[3] === undefined || ["root", "reply", ""].includes(tag[3])),
  );

/** Kinds that are conversation: only these can address an agent. A reaction or a
 * deletion of the agent's message is not someone talking to it. */
export const CHAT_KINDS: readonly number[] = [9, 40003, 40007, 46010];

/** Directly addressed events take the runtime's built-in mention path, never a
 * watch: a chat event that p-tags the agent or replies to something it wrote.
 * DMs (kind 4) are not delivered yet: `run` could neither read nor answer one. */
export function addressedTo(
  event: EventData,
  agent: string,
  wroteEvent: (id: string) => boolean = () => false,
) {
  if (event.pubkey === agent || !CHAT_KINDS.includes(event.kind)) return false;
  return (
    tagsAgent(event, agent) ||
    event.tags.some((tag) => tag[0] === "e" && !!tag[1] && wroteEvent(tag[1]))
  );
}
export const tagsAgent = (event: EventData, agent: string) =>
  event.tags.some((tag) => tag[0] === "p" && tag[1] === agent);

/** Steps 1, 2 and 4 of event watch matching. Step 3 (addressed events and the
 * agent's own events) belongs to the caller; classifiers are not run here. */
export function watchMatches(
  watch: EventWatch,
  event: EventData,
  filter?: Predicate,
): boolean {
  if (!watch.enabled || event.created_at < watch.since) return false;
  if (watch.channels !== "all") {
    const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
    if (!channel || !watch.channels.includes(channel)) return false;
  }
  if (watch.kinds.length && !watch.kinds.includes(event.kind)) return false;
  for (const [key, values] of Object.entries(watch.tags ?? {}))
    if (
      !event.tags.some(
        (tag) =>
          tag[0] === key && tag[1] !== undefined && values.includes(tag[1]),
      )
    )
      return false;
  return filter ? filter(event) : true;
}

/** Runtime schedule state for one timer. Not config: it never leaves the runner. */
export type TimerState = Readonly<{
  armedAt: number;
  nextDue: number;
  used: number;
}>;
export function timerState(
  timer: TimerWatch,
  prior: TimerState | undefined,
): TimerState {
  return prior && prior.armedAt === timer.armed_at
    ? prior
    : {
        armedAt: timer.armed_at,
        nextDue: timer.armed_at + timer.interval_secs,
        used: 0,
      };
}
export function timerSpent(timer: TimerWatch, state: TimerState, now: number) {
  return (
    (timer.expires_at !== null && now >= timer.expires_at) ||
    (timer.max_occurrences !== null && state.used >= timer.max_occurrences)
  );
}

// Reading the format for people: one line per watch, objects grouped by role.

export type ChannelChoice = Readonly<{ id: string; name: string }>;
export type Watch = EventWatch | TimerWatch;
export type WatchObject = AttentionObject & { value: Watch };

export const UNITS = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
] as const;
export const plural = (count: number, unit: string) =>
  `${count} ${unit}${count === 1 ? "" : /(ch|s)$/.test(unit) ? "es" : "s"}`;
/** The largest whole unit of `seconds`. */
export function interval(seconds: number) {
  const [unit, size] =
    UNITS.find(([, size]) => seconds % size === 0) ?? UNITS[3];
  return { count: seconds / size, unit, size };
}
export function every(seconds: number) {
  const { count, unit } = interval(seconds);
  return count === 1 ? `Every ${unit}` : `Every ${plural(count, unit)}`;
}
/** `release-triage` reads as "Release triage". */
export const interestTitle = (id: string) => {
  const words = id.replace(/[-_]+/g, " ").trim() || id;
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** One line for a watch, for rows and the peek. */
export function describeWatch(
  watch: Watch,
  channels: readonly ChannelChoice[] = [],
) {
  if (watch.type === "timer") return every(watch.interval_secs);
  if (watch.name) return watch.name;
  const what =
    watch.kinds.length === 1 && watch.kinds[0] === 9
      ? "Messages"
      : watch.kinds.length
        ? `Kind ${watch.kinds.join(", ")} events`
        : "Any event";
  const only =
    watch.channels !== "all" && watch.channels.length === 1
      ? channels.find((item) => item.id === watch.channels[0])
      : undefined;
  const where =
    watch.channels === "all"
      ? "any channel"
      : only
        ? `#${only.name}`
        : plural(watch.channels.length, "channel");
  return `${what} in ${where}${watch.filter ? ", filtered" : ""}`;
}

/** The objects by role, in slug order; `orphans` serve no Interest. */
export function attentionOf(
  attention: Readonly<Record<string, AttentionObject>>,
) {
  const objects = Object.values(attention).sort((a, b) =>
    a.slug.localeCompare(b.slug),
  );
  const interests = objects.filter(
    (object) => object.value.type === "interest",
  );
  const watches = objects.filter(
    (object): object is WatchObject => object.value.type !== "interest",
  );
  const ids = new Set(interests.map((object) => parseSlug(object.slug)?.id));
  return {
    interests,
    watches,
    orphans: watches.filter((object) => !ids.has(object.value.interest_id)),
  };
}
