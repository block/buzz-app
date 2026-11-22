// Eval cases: what's hovered, what speech recognition wrote, and what the
// app should do. Hover specs: `#channel`, `section:Name`, `person:name`,
// `message:id` (see world.ts), or null for nothing. Thing keys: `c-<channel>`,
// `s-<Section>`, `p-<person>`, `e-<emoji>`; places use jump's keys
// (`channel:c-…`, `dm:d-…`, `chat:d-…`, `thread:m-…`).
//
// STT near-misses come from drone00's spike transcripts (RESEARCH/
// VOICE_JUMP_STT_SPIKE): "bus security", "my Durbant", "Baxon", "Vaxon",
// "vaccine", "drone 02"; the rest are the same kind of sound-alike.

export type Category =
  | "forward"
  | "reverse"
  | "navigate"
  | "ambiguity"
  | "new-name"
  | "stt"
  | "none"
  | "global"
  | "no-hover";

export type Expected =
  | Readonly<{
      action: string;
      owner?: string;
      target?: string;
      text?: string;
    }>
  | Readonly<{ navigate: string }>
  | Readonly<{ none: true }>;

export type Case = Readonly<{
  id: string;
  category: Category;
  hover: string | null;
  spoken: string;
  expect: Expected;
}>;

const act = (
  action: string,
  owner?: string,
  target?: string,
  text?: string,
): Expected => ({
  action,
  ...(owner ? { owner } : {}),
  ...(target ? { target } : {}),
  ...(text ? { text } : {}),
});
const go = (navigate: string): Expected => ({ navigate });
const none: Expected = { none: true };

type Row = [Category, string | null, string, Expected];

const ROWS: Row[] = [
  // Forward: the hovered thing owns the action.
  [
    "forward",
    "#buzz-security",
    "star this",
    act("channel.star", "c-buzz-security"),
  ],
  ["forward", "#standup", "star it", act("channel.star", "c-standup")],
  ["forward", "#general", "unstar this", act("channel.unstar", "c-general")],
  [
    "forward",
    "#buzz-feedback",
    "move this to work",
    act("channel.move_to_section", "c-buzz-feedback", "s-Work"),
  ],
  [
    "forward",
    "#hiring",
    "put this in social",
    act("channel.move_to_section", "c-hiring", "s-Social"),
  ],
  [
    "forward",
    "#jev",
    "move this into projects",
    act("channel.move_to_section", "c-jev", "s-Projects"),
  ],
  ["forward", "#random", "mute this", act("channel.mute", "c-random")],
  [
    "forward",
    "#engineering",
    "mark this as read",
    act("channel.mark_read", "c-engineering"),
  ],
  [
    "forward",
    "#hiring",
    "leave this channel",
    act("channel.leave", "c-hiring"),
  ],
  [
    "forward",
    "#buzz-app",
    "add Tulsi to this channel",
    act("channel.add_member", "c-buzz-app", "p-tulsi"),
  ],
  [
    "forward",
    "#buzz-bugs",
    "invite Duncan",
    act("channel.add_member", "c-buzz-bugs", "p-duncan"),
  ],
  [
    "forward",
    "message:m-relay-auth",
    "send this to ART",
    act("message.forward_to_person", "m-relay-auth", "p-art"),
  ],
  [
    "forward",
    "message:m-release-notes",
    "forward this to buzz app",
    act("message.forward_to_channel", "m-release-notes", "c-buzz-app"),
  ],
  [
    "forward",
    "message:m-voice-pr",
    "share this with Pollen",
    act("message.forward_to_person", "m-voice-pr", "p-pollen"),
  ],
  [
    "forward",
    "message:m-voice-pr",
    "thumbs up",
    act("message.react", "m-voice-pr", "e-thumbs up"),
  ],
  [
    "forward",
    "message:m-pets",
    "react with a heart",
    act("message.react", "m-pets", "e-heart"),
  ],
  [
    "forward",
    "message:m-incident",
    "eyes",
    act("message.react", "m-incident", "e-eyes"),
  ],
  [
    "forward",
    "message:m-release-notes",
    "give it a check mark",
    act("message.react", "m-release-notes", "e-white check mark"),
  ],
  [
    "forward",
    "message:m-incident",
    "follow this thread",
    act("message.follow", "m-incident"),
  ],
  [
    "forward",
    "message:m-voice-pr",
    "unfollow this",
    act("message.unfollow", "m-voice-pr"),
  ],
  [
    "forward",
    "message:m-standup",
    "reply to this",
    act("message.reply", "m-standup"),
  ],
  [
    "forward",
    "message:m-voice-pr",
    "copy the link",
    act("message.copy_link", "m-voice-pr"),
  ],
  [
    "forward",
    "message:m-release-notes",
    "mark this unread",
    act("message.mark_unread", "m-release-notes"),
  ],
  [
    "forward",
    "section:Later",
    "collapse this",
    act("section.collapse", "s-Later"),
  ],
  [
    "forward",
    "section:Oncall",
    "delete this section",
    act("section.delete", "s-Oncall"),
  ],
  [
    "forward",
    "person:Morgan",
    "open her profile",
    act("person.profile", "p-morgan"),
  ],
  ["forward", "person:Kenji", "message him", act("person.dm", "p-kenji")],

  // Reverse: the hovered thing is what the action is done to.
  [
    "reverse",
    "#buzz-security",
    "pin this channel to favorites",
    act("channel.star", "c-buzz-security"),
  ],
  [
    "reverse",
    "section:Work",
    "put buzz feedback in here",
    act("channel.move_to_section", "c-buzz-feedback", "s-Work"),
  ],
  [
    "reverse",
    "section:Projects",
    "move jev here",
    act("channel.move_to_section", "c-jev", "s-Projects"),
  ],
  [
    "reverse",
    "section:Agents",
    "move pollen dev into this section",
    act("channel.move_to_section", "c-pollen-dev", "s-Agents"),
  ],
  [
    "reverse",
    "section:Agents",
    "add honey dev here",
    act("channel.move_to_section", "c-honey-dev", "s-Agents"),
  ],
  [
    "reverse",
    "section:Later",
    "throw the offsite planning channel in here",
    act("channel.move_to_section", "c-offsite-planning", "s-Later"),
  ],
  [
    "reverse",
    "section:Work",
    "move the analytics channel here",
    act("channel.move_to_section", "c-analytics", "s-Work"),
  ],
  [
    "reverse",
    "section:Social",
    "move demo day into this",
    act("channel.move_to_section", "c-demo-day", "s-Social"),
  ],
  [
    "reverse",
    "section:Starred",
    "add the docs channel here",
    act("channel.star", "c-docs"),
  ],
  [
    "reverse",
    "person:Duncan",
    "add him to buzz app",
    act("channel.add_member", "c-buzz-app", "p-duncan"),
  ],
  [
    "reverse",
    "person:Priya",
    "invite her to book club",
    act("channel.add_member", "c-book-club", "p-priya"),
  ],
  [
    "reverse",
    "person:Wes",
    "add Wes to the design channel",
    act("channel.add_member", "c-design", "p-wes"),
  ],
  [
    "reverse",
    "person:Alex Chen",
    "put them in the hiring channel",
    act("channel.add_member", "c-hiring", "p-alex"),
  ],

  // Hover is beside the point: just go somewhere.
  [
    "navigate",
    "#pets",
    "take me to buzz security",
    go("channel:c-buzz-security"),
  ],
  [
    "navigate",
    "message:m-standup",
    "go to the jev clock channel",
    go("channel:c-jev-clock"),
  ],
  ["navigate", "section:Work", "open my DM with Tulsi", go("dm:d-Tulsi")],
  ["navigate", null, "take me to general", go("channel:c-general")],
  [
    "navigate",
    "person:Kenji",
    "show me buzz releases",
    go("channel:c-buzz-releases"),
  ],
  ["navigate", "#random", "chat with murderbot", go("chat:d-murderbot")],
  [
    "navigate",
    "message:m-pets",
    "jump to the incident thread",
    go("thread:m-incident"),
  ],
  ["navigate", "#buzz-app", "open this", go("channel:c-buzz-app")],
  ["navigate", null, "go to wells", go("channel:c-wells")],
  [
    "navigate",
    "section:Oncall",
    "open cash server oncall",
    go("channel:c-cash-server-oncall"),
  ],
  ["navigate", "#hiring", "where's the coffee channel", go("channel:c-coffee")],
  ["navigate", "message:m-voice-pr", "take me to Pollen", go("chat:d-Pollen")],
  ["navigate", null, "open the relay auth thread", go("thread:m-relay-auth")],

  // Same type in both slots: which one is the hovered thing?
  [
    "ambiguity",
    "#buzz-security",
    "move this next to general",
    act("channel.move_next_to", "c-buzz-security", "c-general"),
  ],
  [
    "ambiguity",
    "#buzz-security",
    "move general next to this",
    act("channel.move_next_to", "c-general", "c-buzz-security"),
  ],
  [
    "ambiguity",
    "#pets",
    "put this right after random",
    act("channel.move_next_to", "c-pets", "c-random"),
  ],
  [
    "ambiguity",
    "#docs",
    "put onboarding next to this one",
    act("channel.move_next_to", "c-onboarding", "c-docs"),
  ],
  [
    "ambiguity",
    "#ios",
    "move android next to it",
    act("channel.move_next_to", "c-android", "c-ios"),
  ],
  [
    "ambiguity",
    "#jev",
    "move this beside jev clock",
    act("channel.move_next_to", "c-jev", "c-jev-clock"),
  ],
  [
    "ambiguity",
    "#mobile",
    "move this next to iOS",
    act("channel.move_next_to", "c-mobile", "c-ios"),
  ],
  [
    "ambiguity",
    "#music",
    "bring book club over next to this",
    act("channel.move_next_to", "c-book-club", "c-music"),
  ],

  // New names: nothing to find, the name comes from the words.
  [
    "new-name",
    "section:Work",
    "add buzz community",
    act("section.create", undefined, undefined, "Buzz Community"),
  ],
  [
    "new-name",
    null,
    "create a section called reading list",
    act("section.create", undefined, undefined, "Reading List"),
  ],
  [
    "new-name",
    "section:Projects",
    "make a new section for hackathon",
    act("section.create", undefined, undefined, "Hackathon"),
  ],
  [
    "new-name",
    null,
    "new section customers",
    act("section.create", undefined, undefined, "Customers"),
  ],
  [
    "new-name",
    "#random",
    "create a section named experiments",
    act("section.create", undefined, undefined, "Experiments"),
  ],
  [
    "new-name",
    null,
    "add a section called q4 planning",
    act("section.create", undefined, undefined, "Q4 Planning"),
  ],
  [
    "new-name",
    "section:Later",
    "rename this to someday",
    act("section.rename", "s-Later", undefined, "Someday"),
  ],
  [
    "new-name",
    "section:Social",
    "rename this section fun stuff",
    act("section.rename", "s-Social", undefined, "Fun Stuff"),
  ],

  // Speech recognition near-misses for real names.
  [
    "stt",
    "message:m-relay-auth",
    "send this to Baxon",
    act("message.forward_to_person", "m-relay-auth", "p-baxen"),
  ],
  [
    "stt",
    "message:m-voice-pr",
    "share this with Vaxon",
    act("message.forward_to_person", "m-voice-pr", "p-baxen"),
  ],
  [
    "stt",
    "message:m-voice-pr",
    "forward this to vaccine",
    act("message.forward_to_person", "m-voice-pr", "p-baxen"),
  ],
  [
    "stt",
    "message:m-incident",
    "send this to my Durbant",
    act("message.forward_to_person", "m-incident", "p-murderbot"),
  ],
  [
    "stt",
    "message:m-standup",
    "send this to pollin",
    act("message.forward_to_person", "m-standup", "p-pollen"),
  ],
  [
    "stt",
    "message:m-release-notes",
    "forward this to the jab clock channel",
    act("message.forward_to_channel", "m-release-notes", "c-jev-clock"),
  ],
  ["stt", null, "take me to bus security", go("channel:c-buzz-security")],
  [
    "stt",
    null,
    "go to cash server on call",
    go("channel:c-cash-server-oncall"),
  ],
  [
    "stt",
    null,
    "take me to fast voice surge branch",
    go("channel:c-fast-voice-search-branch"),
  ],
  ["stt", null, "open my chat with murder bot", go("chat:d-murderbot")],
  [
    "stt",
    "#wells",
    "add drone 02 to this",
    act("channel.add_member", "c-wells", "p-drone02"),
  ],
  [
    "stt",
    "person:Tulsi",
    "add her to bus app",
    act("channel.add_member", "c-buzz-app", "p-tulsi"),
  ],
  [
    "stt",
    "section:Work",
    "put bus feedback here",
    act("channel.move_to_section", "c-buzz-feedback", "s-Work"),
  ],
  [
    "stt",
    "#pollen-dev",
    "move this next to honey dove",
    act("channel.move_next_to", "c-pollen-dev", "c-honey-dev"),
  ],

  // Nothing the app can do.
  ["none", "#random", "uh never mind", none],
  ["none", "message:m-pets", "what time is it", none],
  ["none", null, "hmm", none],
  ["none", "section:Work", "make it bigger", none],
  ["none", "message:m-standup", "translate this to french", none],
  ["none", "#general", "turn on dark mode", none],

  // Global: no owner.
  ["global", null, "mark everything as read", act("community.mark_all_read")],
  [
    "global",
    "#buzz-app",
    "mark all of it read, the whole community",
    act("community.mark_all_read"),
  ],
];

export const CASES: readonly Case[] = ROWS.map(
  ([category, hover, spoken, expect], i) => ({
    id: `${category}-${String(i + 1).padStart(3, "0")}`,
    category,
    hover,
    spoken,
    expect,
  }),
);
