// The actions the eval offers Jev, and the workspace as the builder takes
// it. IDs follow drone01's registry where it has them (channel.star,
// channel.unstar, channel.move_to_section, message.forward_to_person,
// message.forward_to_channel); the rest are the actions drone02 and drone03
// plan to add, so the eval measures accuracy with a realistically full menu.
import type { JumpPlace } from "../../src/features/search/voice-jump";
import type {
  ConfirmPolicy,
  EntitySlotKind,
  VoiceActionSpec,
  VoiceSlotEntities,
} from "../../src/features/search/voice-actions";
import {
  extractNewSectionName,
  extractRenameText,
} from "../../src/features/search/voice-actions-sidebar";
import type {
  VoiceSlotKind,
  VoiceThing,
} from "../../src/features/search/voice-context";
import { channelVoiceActions } from "../../src/features/search/voice-actions-channel";
import { quickMessageVoiceActions } from "../../src/features/search/voice-actions-message-quick";
import {
  CHANNELS,
  EMOJI,
  MESSAGES,
  PEOPLE,
  SECTIONS,
  channel,
  message,
  person,
} from "./world";

type OwnerKind = Exclude<EntitySlotKind, "emoji">;

const realMoveToSection = (() => {
  const found = channelVoiceActions.find(
    (action) => action.id === "channel.move_to_section",
  );
  if (!found) throw new Error("No channel.move_to_section action");
  return found;
})();

const a = (
  id: string,
  owner: OwnerKind | undefined,
  target: VoiceSlotKind | undefined,
  sentence: (owner: string, target?: string) => string,
  confirm: ConfirmPolicy = "none",
  _global = false,
  whenHovered?: readonly VoiceThing["kind"][],
  extra?: Partial<Pick<VoiceActionSpec, "extractText" | "filterSlot">>,
): VoiceActionSpec => ({
  id,
  owner: owner ?? null,
  ...(target ? { target } : {}),
  confirm,
  ...(whenHovered ? { whenHovered } : {}),
  ...(extra ?? {}),
  describe: ({ hoveredRole, bound }) => {
    const label = bound?.label;
    if (hoveredRole === "owner") {
      return sentence(
        label ?? "this",
        target === "channel"
          ? "another channel"
          : target === "section"
            ? "a section"
            : target === "person"
              ? "someone"
              : target === "emoji"
                ? "an emoji"
                : undefined,
      );
    }
    if (hoveredRole === "target") {
      return sentence(
        owner === "channel"
          ? "a channel"
          : owner === "section"
            ? "a section"
            : owner === "person"
              ? "someone"
              : "something",
        label ?? "this",
      );
    }
    return sentence("this");
  },
});

// drone02's named forms: offered unless the hovered thing is already of
// that kind, so a hovered and a named form never both bind.
const NOT_SECTION = ["channel", "message", "person", "nothing"] as const;
const NOT_PERSON = ["channel", "message", "section", "nothing"] as const;
const named = (
  id: string,
  target: VoiceSlotKind,
  sentence: string,
  whenHovered: readonly VoiceThing["kind"][],
  extra?: Partial<Pick<VoiceActionSpec, "extractText" | "filterSlot">>,
) => a(id, undefined, target, () => sentence, "none", true, whenHovered, extra);

export const ACTIONS: readonly VoiceActionSpec[] = [
  // Channels (drone01 M1 + drone02).
  a("channel.star", "channel", undefined, (o) => `Star ${o}`),
  a("channel.unstar", "channel", undefined, (o) => `Unstar ${o}`),
  {
    id: "channel.move_to_section",
    owner: "channel",
    target: "section",
    confirm: "none",
    filterSlot: (slot, entity) =>
      slot === "section" ? entity.id !== "s-Starred" : true,
    // The real action's sentences. It is owned by the section, so its roles
    // are this stand-in's the other way round.
    describe: ({ hoveredRole, bound }) =>
      hoveredRole === "target" && bound?.id === "s-Starred"
        ? "Star a channel (add a channel to Starred / Favorites)"
        : realMoveToSection.describe({
            hoveredRole:
              hoveredRole === "owner"
                ? "target"
                : hoveredRole === "target"
                  ? "owner"
                  : hoveredRole,
            bound,
          }),
  },
  a("channel.mute", "channel", undefined, (o) => `Mute ${o}`),
  a("channel.mark_read", "channel", undefined, (o) => `Mark ${o} as read`),
  a("channel.leave", "channel", undefined, (o) => `Leave ${o}`, "confirm"),
  a(
    "channel.add_member",
    "channel",
    "person",
    (o, t) => `Add ${t} to ${o}`,
    "confirm",
  ),
  // Sections.
  a(
    "section.create",
    undefined,
    "text",
    () => "Create a new sidebar section with a name they say",
    "confirm",
    true,
    undefined,
    { extractText: extractNewSectionName },
  ),
  a(
    "section.rename",
    "section",
    "text",
    (o) => `Rename the ${o} section`,
    "confirm",
    false,
    undefined,
    { extractText: extractRenameText },
  ),
  a(
    "section.collapse",
    "section",
    undefined,
    (o) => `Collapse the ${o} section`,
  ),
  // Messages and threads (drone01's forward + drone03).
  a(
    "message.forward_to_person",
    "message",
    "person",
    (o, t) => `Forward ${o} to ${t}`,
    "confirm",
  ),
  a(
    "message.forward_to_channel",
    "message",
    "channel",
    (o, t) => `Forward ${o} to ${t}`,
    "confirm",
  ),
  // The real quick message and thread actions (react, reply, follow,
  // unfollow, copy link, mark unread), with their own sentences.
  ...quickMessageVoiceActions,
  // People.
  a("person.profile", "person", undefined, (o) => `Open ${o}'s profile`),
  a("person.dm", "person", undefined, (o) => `Send ${o} a direct message`),
  // Named forms and self (drone02): the no-hover menu.
  named(
    "section.filter_unreads.named",
    "section",
    "Show only unread channels in a section",
    NOT_SECTION,
  ),
  named(
    "section.filter_all.named",
    "section",
    "Show every channel in a section",
    NOT_SECTION,
  ),
  named(
    "section.collapse.named",
    "section",
    "Collapse a sidebar section (hide its channels)",
    NOT_SECTION,
  ),
  named(
    "section.expand.named",
    "section",
    "Expand a sidebar section (show its channels)",
    NOT_SECTION,
  ),
  named(
    "person.dm.named",
    "person",
    "Send someone a direct message",
    NOT_PERSON,
  ),
  named("person.profile.named", "person", "Show someone's profile", NOT_PERSON),
  a(
    "self.set_away",
    undefined,
    undefined,
    () => "Set my availability to away",
    "none",
    true,
  ),
  a(
    "self.set_active",
    undefined,
    undefined,
    () => "Set my availability to active (I'm back)",
    "none",
    true,
  ),
  a(
    "self.set_offline",
    undefined,
    undefined,
    () => "Set my availability to appear offline",
    "none",
    true,
  ),
  // Community.
  a(
    "community.mark_all_read",
    undefined,
    undefined,
    () => "Mark everything in the community as read",
    "confirm",
    true,
  ),
];

/** Actions some cases ask for that the app doesn't offer: exact sidebar
 * positions and deletions are left out of voice on purpose. Those cases
 * expect no action (options or nothing), never some other one. */
export const UNOFFERED: ReadonlySet<string> = new Set([
  "channel.move_next_to",
  "section.delete",
  "message.delete",
]);

export const CONFIRM = new Set(
  ACTIONS.filter((x) => x.confirm === "confirm").map((x) => x.id),
);

export const ENTITIES: VoiceSlotEntities = {
  channel: CHANNELS.map((c) => ({
    kind: "channel",
    id: c.id,
    label: `#${c.name}`,
    soundsLikeName: c.name,
    ...(c.about ? { detail: c.about } : {}),
  })),
  section: SECTIONS.map((s) => ({
    kind: "section",
    id: `s-${s}`,
    label: s,
    soundsLikeName: s,
    ...(s === "Starred" ? { detail: "Built in: starred channels" } : {}),
  })),
  person: PEOPLE.map((p) => ({
    kind: "person",
    id: p.id,
    label: p.name,
    soundsLikeName: p.name,
    detail: p.agent ? "agent" : "person",
  })),
  emoji: Object.entries(EMOJI).map(([name, glyph]) => ({
    kind: "emoji",
    id: `e-${name}`,
    label: name,
    soundsLikeName: name,
    detail: glyph,
  })),
};

/** Jump's places, most recent first: channels, DMs and agent chats, threads,
 * capped at jump's 200. */
export const PLACES: readonly JumpPlace[] = [
  ...CHANNELS.map(
    (c, i): JumpPlace => ({
      key: `channel:${c.id}`,
      kind: "channel",
      channelId: c.id,
      name: c.name,
      // Only jump's 40 most recent places carry their details.
      ...(i < 40 && c.about ? { about: c.about } : {}),
      ...(i < 40 && c.recent ? { recent: c.recent } : {}),
      at: 1000 - i,
    }),
  ),
  ...PEOPLE.filter((p) => p.dm).map(
    (p, i): JumpPlace => ({
      key: `${p.agent ? "chat" : "dm"}:d-${p.name}`,
      kind: p.agent ? "chat" : "dm",
      channelId: `d-${p.name}`,
      name: p.name,
      at: 900 - i,
    }),
  ),
  ...MESSAGES.filter((m) => m.replies).map(
    (m, i): JumpPlace => ({
      key: `thread:${m.id}`,
      kind: "thread",
      channelId: `c-${m.channel}`,
      rootId: m.id,
      name: `${m.author}: ${m.text}`,
      in: m.channel,
      at: 800 - i,
    }),
  ),
].slice(0, 200);

/** Hover targets, by a short spec: `#name`, `section:Name`, `person:name`,
 * `message:id`, `thread:id` (an open thread, by its root), or null for
 * nothing. */
export function hover(spec: string | null): VoiceThing | null {
  if (spec === null) return null;
  if (spec.startsWith("#")) {
    const c = channel(spec.slice(1));
    return {
      kind: "channel",
      id: c.id,
      name: c.name,
      label: `#${c.name}`,
    };
  }
  const [kind, rest] = [
    spec.slice(0, spec.indexOf(":")),
    spec.slice(spec.indexOf(":") + 1),
  ];
  if (kind === "section") {
    return {
      kind: "section",
      id: `s-${rest}`,
      name: rest,
      label: rest,
    };
  }
  if (kind === "person") {
    const p = person(rest);
    return {
      kind: "person",
      id: p.id,
      name: p.name,
      label: p.name,
    };
  }
  if (kind === "message") {
    const m = message(rest);
    return {
      kind: "message",
      id: m.id,
      channelId: `c-${m.channel}`,
      authorName: m.author,
      preview: m.text,
      label: `this message from ${m.author}`,
    };
  }
  if (kind === "thread") {
    const m = message(rest);
    return {
      kind: "thread",
      id: m.id,
      channelId: `c-${m.channel}`,
      label: `the thread "${m.text}" in #${m.channel}`,
    };
  }
  throw new Error(`Bad hover spec ${spec}`);
}
