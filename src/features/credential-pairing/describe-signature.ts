import { formatPublicKey } from "../../shared/identity/public-key";

export type SignatureLookup = {
  /** The channel's name, when the app already knows it. */
  channel?(id: string): string | undefined;
  /** The person's display name, when the app already knows it. */
  person?(pubkey: string): string | undefined;
};

export type SignatureDescription = {
  /** What this one request does: "leave #general". */
  action: string;
  /** The kind in general, after "Can": "leave channels". */
  ability: string;
};

type Tags = readonly (readonly string[])[];
type Entry = {
  ability: string;
  action(tags: Tags, text: Text): string;
  /** The tags the words account for. Any other tag, when this is set, adds
   * "with other settings": the relay may act on what is not shown. */
  tags?: readonly string[];
};
type Text = {
  channel: string | undefined;
  people: string | undefined;
};

const MAX_NAME = 60;
/** Tags that change nothing the relay does. */
const INERT = new Set(["alt", "client", "-"]);
/** Tags that may repeat, each naming one more target or label. */
const LISTS = new Set(["p", "e", "a", "t"]);
/** Whether a tag the words name repeats with another value: which one the
 * relay acts on differs by tag, so the words cannot say. */
const repeated = (tags: Tags, covered: readonly string[]) =>
  covered.some(
    (name) =>
      !LISTS.has(name) &&
      new Set(
        tags.filter((tag) => tag[0] === name).map((tag) => tag[1] ?? null),
      ).size > 1,
  );
const first = (tags: Tags, name: string) =>
  tags.find((tag) => tag[0] === name)?.[1];
const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");
const has = (tags: Tags, name: string) => tags.some((tag) => tag[0] === name);
const list = (parts: readonly string[]) =>
  parts.length < 2
    ? parts.join("")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
/** " until <time>" for a Unix-seconds `expiration`, or `otherwise`. */
const until = (tags: Tags, otherwise: string) => {
  const value = first(tags, "expiration");
  if (value === undefined) return otherwise;
  const seconds = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(seconds))
    return " with other settings";
  return ` until ${new Date(seconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })}`;
};
/** The roles a member addition grants: each `p` tag's third value, or the
 * `role` tag the relay falls back to. */
const roles = (tags: Tags) => {
  const fallback = first(tags, "role");
  const seen = new Map<string, string | undefined>();
  for (const tag of tags)
    if (tag[0] === "p" && tag[1] && !seen.has(tag[1]))
      seen.set(tag[1], tag[2] || fallback);
  const granted = new Set(seen.size ? seen.values() : [fallback]);
  if (granted.size === 1) {
    const [role] = granted;
    return role ? ` as ${article(role)} ${clip(role)}` : "";
  }
  return " with different roles";
};
const CHANNEL_TYPES: Readonly<Record<string, string>> = {
  stream: "channel",
  forum: "forum",
  dm: "DM",
  workflow: "workflow channel",
  system: "system channel",
};
/** What a channel edit changes, each worded for `it`, the channel. */
const edits = (tags: Tags): ((it: string) => string)[] => {
  const changes: ((it: string) => string)[] = [];
  const archived = first(tags, "archived");
  if (archived !== undefined)
    changes.push(
      (it) => `${archived === "true" ? "archive" : "unarchive"} ${it}`,
    );
  if (has(tags, "name")) changes.push((it) => `rename ${it}`);
  if (["about", "topic", "purpose"].some((tag) => has(tags, tag)))
    changes.push((it) =>
      it === "it"
        ? "change its description"
        : `change the description of ${it}`,
    );
  const visibility = first(tags, "visibility");
  if (visibility !== undefined)
    changes.push((it) =>
      visibility === "private"
        ? `make ${it} private`
        : `make ${it} open to everyone`,
    );
  const joinRole = first(tags, "join_role");
  if (joinRole !== undefined)
    changes.push((it) =>
      joinRole === "guest"
        ? `make people who join ${it} guests who can't post`
        : `let people who join ${it} post`,
    );
  const unlisted = first(tags, "unlisted");
  if (unlisted !== undefined)
    changes.push((it) =>
      unlisted === "true"
        ? `hide ${it} from the channel list`
        : `show ${it} in the channel list`,
    );
  const autoJoin = first(tags, "auto_join");
  if (autoJoin !== undefined)
    changes.push(
      (it) => `turn auto-join ${autoJoin === "true" ? "on" : "off"} for ${it}`,
    );
  const ttl = first(tags, "ttl");
  if (ttl !== undefined)
    changes.push((it) =>
      ttl === ""
        ? `keep messages in ${it}`
        : `make messages in ${it} disappear`,
    );
  if (has(tags, "t")) changes.push((it) => `change the labels of ${it}`);
  return changes;
};
const EDIT_TAGS = [
  "h",
  "archived",
  "name",
  "about",
  "topic",
  "purpose",
  "visibility",
  "join_role",
  "unlisted",
  "auto_join",
  "ttl",
  "t",
];
const RESOLUTIONS: Readonly<Record<string, string>> = {
  delete: "resolve a report and delete what was reported",
  kick: "resolve a report and remove the person",
  ban: "resolve a report and ban the person",
  timeout: "resolve a report and time out the person",
  escalate: "escalate a report",
};
const clip = (value: string) =>
  [...value].length > MAX_NAME
    ? `${[...value].slice(0, MAX_NAME).join("")}…`
    : value;

const fixed = (
  action: string,
  ability: string,
  extra?: Partial<Entry>,
): Entry => ({ ability, action: () => action, ...extra });
const inChannel = (verb: string, text: Text) =>
  text.channel ? `${verb} in ${text.channel}` : verb;
const admin: Entry = {
  ability: "change channel admin settings",
  action: (_tags, text) =>
    text.channel
      ? `change admin settings for ${text.channel}`
      : "change channel admin settings",
};

const KINDS: Readonly<Record<number, Entry>> = {
  0: fixed("change your profile", "change your profile"),
  3: fixed("change your contact list", "change your contact list"),
  // A target may be anything the person or their agents posted; `k` is only
  // its kind as the tool claims it, so it is not shown.
  5: {
    ability: "delete what you or your agents posted",
    action: (tags) => {
      const targets = tags.filter((tag) => tag[0] === "e" || tag[0] === "a");
      return targets.length > 1
        ? `delete ${targets.length} things you or your agents posted`
        : "delete something you or your agents posted";
    },
    tags: ["e", "a", "k", "h"],
  },
  9000: {
    ability: "add channel members",
    action: (tags, text) =>
      `add ${text.people ?? "a member"} to ${text.channel ?? "a channel"}${roles(tags)}`,
    tags: ["h", "p", "role"],
  },
  9001: {
    ability: "remove channel members",
    action: (_tags, text) =>
      `remove ${text.people ?? "a member"} from ${text.channel ?? "a channel"}`,
    tags: ["h", "p"],
  },
  9002: {
    ability: "edit channels",
    action: (tags, text) => {
      const target = text.channel ?? "a channel";
      const changes = edits(tags);
      const [only] = changes;
      if (!only) return `edit ${target}`;
      if (changes.length === 1) return only(target);
      return `edit ${target}: ${list(changes.map((change) => change("it")))}`;
    },
    tags: EDIT_TAGS,
  },
  9003: admin,
  9004: admin,
  9005: {
    ability: "delete messages",
    // Any moderation tag turns the author's own deletion into a moderator's.
    action: (tags, text) =>
      inChannel(
        ["action_id", "reason_code", "public_reason"].some((tag) =>
          has(tags, tag),
        )
          ? "delete a message as a moderator"
          : "delete a message",
        text,
      ),
    tags: ["h", "e", "action_id", "reason_code", "public_reason"],
  },
  9006: admin,
  9007: {
    ability: "create channels",
    action: (tags, text) => {
      const type = first(tags, "channel_type") ?? "stream";
      const noun =
        (Object.hasOwn(CHANNEL_TYPES, type) && CHANNEL_TYPES[type]) ||
        `${clip(type)} channel`;
      const visibility =
        first(tags, "visibility") ?? (type === "system" ? "private" : "open");
      const name = first(tags, "name");
      const extras = [
        ...(text.people ? [`with ${text.people}`] : []),
        ...(first(tags, "unlisted") === "true"
          ? ["hidden from the channel list"]
          : []),
        ...(has(tags, "ttl") ? ["where messages disappear"] : []),
      ];
      const what = `${visibility === "private" ? "private " : ""}${noun}`;
      const named = name
        ? `the ${what} “${clip(name)}”`
        : `${article(what)} ${what}`;
      return [`create ${named}`, ...extras].join(", ");
    },
    tags: [
      "h",
      "name",
      "channel_type",
      "visibility",
      "about",
      "t",
      "unlisted",
      "ttl",
      "p",
    ],
  },
  9008: {
    ability: "delete channels",
    action: (_tags, text) => `delete ${text.channel ?? "a channel"}`,
    tags: ["h"],
  },
  9009: admin,
  9021: {
    ability: "join channels",
    action: (_tags, text) => `join ${text.channel ?? "a channel"}`,
    tags: ["h"],
  },
  9022: {
    ability: "leave channels",
    action: (_tags, text) => `leave ${text.channel ?? "a channel"}`,
    tags: ["h"],
  },
  // Moderation acts on the whole community; any `h` is not read.
  9040: {
    ability: "ban people from the community",
    action: (tags, text) =>
      `ban ${text.people ?? "someone"} from the community${until(tags, " permanently")}`,
    tags: ["p", "expiration", "reason", "h"],
  },
  9041: {
    ability: "unban people from the community",
    action: (_tags, text) => `unban ${text.people ?? "someone"}`,
    tags: ["p", "h"],
  },
  9042: {
    ability: "time out people in the community",
    action: (tags, text) =>
      `time out ${text.people ?? "someone"}${until(tags, "")}`,
    tags: ["p", "expiration", "reason", "h"],
  },
  9043: {
    ability: "end timeouts in the community",
    action: (_tags, text) => `end the timeout for ${text.people ?? "someone"}`,
    tags: ["p", "h"],
  },
  9044: {
    ability: "resolve reports",
    action: (tags) => {
      const action = first(tags, "action");
      if (action === "dismiss" || first(tags, "status") === "dismissed")
        return "dismiss a report";
      return (
        (action && Object.hasOwn(RESOLUTIONS, action) && RESOLUTIONS[action]) ||
        "resolve a report"
      );
    },
    tags: ["report", "status", "action", "reason", "h"],
  },
  10002: fixed("change your relay list", "change your relay list"),
  10100: fixed("change your agent profile", "change your agent profile"),
  28936: fixed("leave the community", "leave the community"),
  30175: fixed("change a persona", "change personas"),
  30176: fixed("change a team", "change teams"),
  30177: fixed("change a managed agent", "change managed agents"),
  30179: fixed("change a managed agent", "change managed agents"),
  30617: fixed("announce a repository", "announce repositories"),
  30618: fixed("update a repository’s state", "update repository state"),
  30620: fixed("change a workflow", "change workflows"),
  30621: fixed("change a project", "change projects"),
  41011: {
    ability: "add people to DMs",
    action: (tags, text) =>
      `add ${text.people ?? "someone"} to a DM${first(tags, "history") === "include" ? " and show them its history" : ""}`,
    tags: ["h", "p", "history"],
  },
  45011: fixed("remove an artifact", "remove artifacts"),
  46030: fixed("approve a workflow step", "approve workflow steps"),
  46031: fixed("deny a workflow step", "deny workflow steps"),
};

const channelLabel = (id: string, lookup: SignatureLookup) => {
  const name = lookup.channel?.(id)?.trim();
  return name ? `#${clip(name)}` : `channel ${id.slice(0, 8)}`;
};

const personLabel = (pubkey: string, lookup: SignatureLookup) => {
  const name = lookup.person?.(pubkey)?.trim();
  return name ? clip(name) : (formatPublicKey(pubkey) ?? "someone");
};

const peopleLabel = (
  tags: readonly (readonly string[])[],
  lookup: SignatureLookup,
) => {
  const keys = [
    ...new Set(
      tags.flatMap((tag) => (tag[0] === "p" && tag[1] ? [tag[1]] : [])),
    ),
  ];
  const [one, two] = keys;
  if (one === undefined) return undefined;
  if (two === undefined) return personLabel(one, lookup);
  return keys.length === 2
    ? `${personLabel(one, lookup)} and ${personLabel(two, lookup)}`
    : `${personLabel(one, lookup)} and ${keys.length - 1} others`;
};

/** Says in plain words what a tool asks Buzz to sign. The event's `content`
 * is never read: only its kind and its tags. A tag the words leave out adds
 * "with other settings", so the sentence never says less than is signed. */
export function describeSignature(
  kind: number,
  tags: readonly (readonly string[])[],
  lookup: SignatureLookup = {},
): SignatureDescription {
  const entry = Object.hasOwn(KINDS, kind) ? KINDS[kind] : undefined;
  if (!entry)
    return {
      action: `sign a kind ${kind} event`,
      ability: `sign kind ${kind} events`,
    };
  const channelId = first(tags, "h");
  const action = entry.action(tags, {
    channel: channelId ? channelLabel(channelId, lookup) : undefined,
    people: peopleLabel(tags, lookup),
  });
  const covered = entry.tags;
  const other =
    covered !== undefined &&
    (tags.some(
      (tag) => !INERT.has(tag[0] ?? "") && !covered.includes(tag[0] ?? ""),
    ) ||
      repeated(tags, covered));
  return {
    action:
      other && !action.endsWith(" with other settings")
        ? `${action} with other settings`
        : action,
    ability: entry.ability,
  };
}
