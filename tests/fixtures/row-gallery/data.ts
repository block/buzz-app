// The avatar is who you'd be talking to: the latest poster who isn't you in
// Team, the agent in Solo, the other person in DMs.
// Illustrative conversations for the row specimen sheet. Names echo the real
// workspace so the content has realistic lengths; nothing here is live data.

export type Who = {
  name: string;
  agent?: boolean;
  /** Two hues for the generated avatar; omit to show the monogram fallback. */
  hues?: [number, number];
};

export type Row = {
  id: string;
  who: Who;
  place: string;
  kind?: "channel" | "private" | "thread" | "solo" | "dm";
  /** Only "You": the avatar says who for everyone else. */
  sender?: string;
  preview: string;
  time: string;
  state?: "read" | "unread" | "working";
};

const person = (name: string, a: number, b: number): Who => ({
  name,
  hues: [a, b],
});
const agent = (name: string, a: number, b: number): Who => ({
  name,
  agent: true,
  hues: [a, b],
});

export const people = {
  max: person("Max Okafor", 18, 42),
  tomb: person("tomb", 200, 230),
  wren: person("Wren Patel", 150, 175),
  eva: person("Eva Chen", 320, 350),
  jamie: person("Jamie Lee", 260, 290),
  priya: person("Priya Nair", 35, 60),
  sam: person("Sam Rivera", 190, 160),
  alexandria: person("Alexandria Montgomery-Fitzgerald", 280, 250),
  wes: { name: "Wes" } satisfies Who,
};
export const agents = {
  mbot: agent("mbot", 4, 24),
  codex: agent("codex00", 210, 240),
  art: agent("ART", 280, 310),
  drone: agent("drone01", 95, 130),
  honey: agent("Honey", 40, 50),
};

export const solo: Row[] = [
  {
    id: "s1",
    who: agents.mbot,
    place: "Activity-first sidebar",
    preview: "Both fixes are in 57cc8467a, same branch. It should hot-reload.",
    time: "2m",
    state: "unread",
  },
  {
    id: "s2",
    who: agents.mbot,
    place: "Fix flaky shell tests",
    preview: "Running the shell suite again…",
    time: "now",
    state: "working",
  },
  {
    id: "s3",
    who: agents.codex,
    place: "Layout studies",
    preview:
      "Here are two focused menu studies, each shown across Solo / Team / DMs.",
    time: "41m",
  },
  {
    id: "s4",
    who: agents.art,
    place: "Release notes 1.4",
    preview: "Draft is in OUTBOX/RELEASE_NOTES_1_4.md. Want me to post it?",
    time: "2h",
    state: "unread",
  },
  {
    id: "s5",
    who: agents.drone,
    place: "Relay load at reconnect",
    preview:
      "306 filters per reconnect on a 300-channel client. Cursor replay brings it to 3.",
    time: "5h",
  },
  {
    id: "s6",
    who: agents.mbot,
    place:
      "Investigate why NIP-FI sign-in loops when the Builderlab session expires mid-launch",
    sender: "You",
    preview: "ok try the refresh path first",
    time: "Mon",
  },
  {
    id: "s7",
    who: agents.honey,
    place: "Morning brief",
    preview: "3 PRs need your review, 1 incident resolved overnight.",
    time: "Tue",
  },
];

export const channels: Row[] = [
  {
    id: "c1",
    who: people.max,
    place: "#buzz-release",
    preview: "Cut 1.4.2 from main, notarizing now.",
    time: "now",
    state: "unread",
  },
  {
    id: "c2",
    who: people.tomb,
    place: "#buzz-onedotzero",
    preview: "which ones are still flaky after the retry removal?",
    time: "8m",
    state: "unread",
  },
  {
    id: "c3",
    who: people.wren,
    place: "#buzz-agent-memory",
    preview: "Core memory budget is 10 KB; most agents sit around 4.",
    time: "31m",
  },
  {
    id: "c4",
    who: people.eva,
    place: "#design",
    preview: "Pushed new avatar shapes to the specimen sheet 🎨",
    time: "1h",
  },
  {
    id: "c5",
    who: people.jamie,
    place: "leads",
    kind: "private",
    preview: "Moving staff sync to Thursday.",
    time: "3h",
    state: "unread",
  },
  {
    id: "c6",
    who: people.priya,
    place: "#random",
    preview: "🍜",
    time: "Tue",
  },
  {
    id: "c7",
    who: people.wes,
    place: "#general",
    preview: "Welcome to the workspace!",
    time: "Sep 12",
  },
];

export const threads: Row[] = [
  {
    id: "t1",
    who: people.max,
    kind: "thread",
    place: "in #buzz-release",
    preview: "Notarized, uploading to the CDN.",
    time: "now",
    state: "unread",
  },
  {
    id: "t2",
    who: agents.mbot,
    kind: "thread",
    place: "in #buzz-onedotzero",
    preview: "Fixed in a02a565, it was the frozen-order timer.",
    time: "12m",
    state: "unread",
  },
  {
    id: "t3",
    who: people.eva,
    kind: "thread",
    place: "in #buzz-agent-memory",
    preview: "+1, as long as cold slugs stay linked.",
    time: "40m",
  },
  {
    id: "t4",
    who: people.sam,
    kind: "thread",
    place: "in #buzz-identity",
    preview: "I think yes, but only for the refresh path.",
    time: "2h",
  },
  {
    id: "t5",
    who: people.priya,
    kind: "thread",
    place: "in #random",
    preview: "Ramen at 12:30",
    time: "Tue",
  },
];

export const mentions: Row[] = [
  {
    id: "m1",
    who: people.max,
    place: "#buzz-release",
    preview: "@baxen can you approve the release PR?",
    time: "4m",
    state: "unread",
  },
  {
    id: "m2",
    who: people.wren,
    kind: "thread",
    place: "in #buzz-agent-memory",
    preview: "@baxen ok to drop the 64 KB cap from the docs?",
    time: "1h",
    state: "unread",
  },
  {
    id: "m3",
    who: people.eva,
    place: "#design",
    preview: "@baxen which avatar shape do you prefer, A or B?",
    time: "3h",
  },
  {
    id: "m4",
    who: people.tomb,
    place: "#buzz-onedotzero",
    preview: "@baxen @mbot all green now",
    time: "Mon",
  },
];

export const dms: Row[] = [
  {
    id: "d1",
    who: people.eva,
    kind: "dm",
    place: "Eva Chen",
    preview: "Can you look at the motion spec before Friday?",
    time: "20m",
    state: "unread",
  },
  {
    id: "d2",
    who: people.sam,
    kind: "dm",
    place: "Sam Rivera",
    sender: "You",
    preview: "sounds good, ship it",
    time: "1h",
  },
  {
    id: "d3",
    who: people.priya,
    kind: "dm",
    place: "Max Okafor, Priya Nair",
    preview: "I'll book the room",
    time: "2h",
  },
  {
    id: "d4",
    who: people.alexandria,
    kind: "dm",
    place: "Alexandria Montgomery-Fitzgerald",
    preview:
      "Following up on the onboarding doc. I left comments on sections 2 and 4.",
    time: "Mon",
  },
  {
    id: "d5",
    who: people.jamie,
    kind: "dm",
    place: "Jamie Lee",
    preview: "Thanks!",
    time: "Tue",
  },
  {
    id: "d6",
    who: people.wes,
    kind: "dm",
    place: "Wes",
    preview: "👍",
    time: "Sep 30",
  },
];
