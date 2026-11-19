// The final fresh set (`--set final`): written before its first run, on
// channels, people, a message and phrasings no other set uses. Its first
// results are the clean number; no wording or rule is changed on account of
// them.
import type { Case, Category, Expected } from "./cases";

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
  // Sidebar: channels and sections.
  [
    "forward",
    "#square-oncall",
    "mute it",
    act("channel.mute", "c-square-oncall"),
  ],
  [
    "forward",
    "#data-platform",
    "move this into work",
    act("channel.move_to_section", "c-data-platform", "s-Work"),
  ],
  [
    "reverse",
    "section:Escalations",
    "put support escalations in here",
    act("channel.move_to_section", "c-support-escalations", "s-Escalations"),
  ],
  [
    "forward",
    "#growth-experiments",
    "add this to my favorites",
    act("channel.star", "c-growth-experiments"),
  ],
  [
    "forward",
    "section:Projects",
    "collapse it",
    act("section.collapse", "s-Projects"),
  ],
  [
    "ambiguity",
    "#growth-experiments",
    "move this right below data platform",
    act("channel.move_next_to", "c-growth-experiments", "c-data-platform"),
  ],
  [
    "new-name",
    null,
    "make a section for customer calls",
    act("section.create", undefined, undefined, "Customer Calls"),
  ],
  [
    "new-name",
    "section:Later",
    "rename it archive",
    act("section.rename", "s-Later", undefined, "Archive"),
  ],
  [
    "forward",
    "#buzz-design",
    "mark it read",
    act("channel.mark_read", "c-buzz-design"),
  ],

  // People.
  [
    "reverse",
    "person:Rahul",
    "add him to data platform",
    act("channel.add_member", "c-data-platform", "p-rahul"),
  ],
  [
    "forward",
    "#support-escalations",
    "invite Ines",
    act("channel.add_member", "c-support-escalations", "p-ines"),
  ],
  [
    "forward",
    "person:Ines Duarte",
    "open her profile",
    act("person.profile", "p-ines"),
  ],

  // Messages and threads.
  [
    "forward",
    "message:m-outage",
    "follow this one",
    act("message.follow", "m-outage"),
  ],
  ["forward", "message:m-outage", "reply", act("message.reply", "m-outage")],
  [
    "forward",
    "message:m-outage",
    "send this to Ines",
    act("message.forward_to_person", "m-outage", "p-ines"),
  ],
  [
    "forward",
    "message:m-outage",
    "forward it to the incidents channel",
    act("message.forward_to_channel", "m-outage", "c-incidents"),
  ],
  [
    "forward",
    "message:m-outage",
    "heart it",
    act("message.react", "m-outage", "e-heart"),
  ],
  [
    "forward",
    "message:m-lunch",
    "laugh at this",
    act("message.react", "m-lunch", "e-laughing"),
  ],
  [
    "forward",
    "message:m-outage",
    "copy its link",
    act("message.copy_link", "m-outage"),
  ],
  [
    "forward",
    "thread:m-outage",
    "stop notifying me about this",
    act("thread.unfollow", "m-outage"),
  ],
  [
    "navigate",
    "message:m-standup",
    "take me to the login loops thread",
    go("thread:m-outage"),
  ],

  // Nothing hovered.
  ["no-hover", null, "set my status to away", act("self.set_away")],
  [
    "no-hover",
    null,
    "collapse oncall",
    act("section.collapse.named", undefined, "s-Oncall"),
  ],
  [
    "no-hover",
    null,
    "go to growth experiments",
    go("channel:c-growth-experiments"),
  ],
  [
    "no-hover",
    null,
    "show only unreads in social",
    act("section.filter_unreads.named", undefined, "s-Social"),
  ],
  [
    "no-hover",
    null,
    "message Rahul",
    act("person.dm.named", undefined, "p-rahul"),
  ],

  // Names speech recognition gets wrong.
  [
    "stt",
    "message:m-outage",
    "send this to Raul",
    act("message.forward_to_person", "m-outage", "p-rahul"),
  ],
  ["stt", null, "open the data platter channel", go("channel:c-data-platform")],
  [
    "stt",
    "message:m-deploy",
    "forward to ios beta two",
    act("message.forward_to_channel", "m-deploy", "c-ios-beta-2"),
  ],
  [
    "stt",
    "person:tracer9",
    "add tracer nine to support escalations",
    act("channel.add_member", "c-support-escalations", "p-tracer9"),
  ],

  // Nothing to do.
  ["none", "#data-platform", "what's this channel for", none],
];

export const FINAL: readonly Case[] = ROWS.map(
  ([category, hover, spoken, expect], i) => ({
    id: `final-${category}-${String(i + 1).padStart(3, "0")}`,
    category,
    hover,
    spoken,
    expect,
  }),
);

// "In here" set (`--set here`): written before the move-into-section wording
// change it scores, on moves said as "put X in here" over a section and on
// real navigates with a section hovered. Scored once, apart from `final`.
const HERE_ROWS: Row[] = [
  [
    "reverse",
    "section:Projects",
    "drop data platform in here",
    act("channel.move_to_section", "c-data-platform", "s-Projects"),
  ],
  [
    "reverse",
    "section:Later",
    "stick the coffee channel here",
    act("channel.move_to_section", "c-coffee", "s-Later"),
  ],
  [
    "reverse",
    "section:Work",
    "put the product channel in here",
    act("channel.move_to_section", "c-product", "s-Work"),
  ],
  [
    "reverse",
    "section:Agents",
    "throw goose in here",
    act("channel.move_to_section", "c-goose", "s-Agents"),
  ],
  [
    "reverse",
    "section:Escalations",
    "add incidents to this section",
    act("channel.move_to_section", "c-incidents", "s-Escalations"),
  ],
  [
    "reverse",
    "section:Oncall",
    "drop sre alerts in here",
    act("channel.move_to_section", "c-sre-alerts", "s-Oncall"),
  ],
  [
    "reverse",
    "section:Later",
    "put hiring here",
    act("channel.move_to_section", "c-hiring", "s-Later"),
  ],
  [
    "reverse",
    "section:Projects",
    "this is where web perf goes",
    act("channel.move_to_section", "c-web-perf", "s-Projects"),
  ],
  [
    "reverse",
    "section:Social",
    "put analytics in here",
    act("channel.move_to_section", "c-analytics", "s-Social"),
  ],
  [
    "reverse",
    "section:Work",
    "move relay perf in",
    act("channel.move_to_section", "c-relay-perf", "s-Work"),
  ],
  [
    "navigate",
    "section:Work",
    "open data platform",
    go("channel:c-data-platform"),
  ],
  [
    "navigate",
    "section:Projects",
    "take me to growth experiments",
    go("channel:c-growth-experiments"),
  ],
  [
    "navigate",
    "section:Oncall",
    "go to the incidents channel",
    go("channel:c-incidents"),
  ],
  ["navigate", "section:Later", "show me hiring", go("channel:c-hiring")],
  [
    "navigate",
    "section:Social",
    "jump to ux research",
    go("channel:c-ux-research"),
  ],
  ["navigate", "section:Agents", "open my chat with Honey", go("chat:d-Honey")],
];

export const HERE: readonly Case[] = HERE_ROWS.map(
  ([category, hover, spoken, expect], i) => ({
    id: `here-${category}-${String(i + 1).padStart(3, "0")}`,
    category,
    hover,
    spoken,
    expect,
  }),
);
