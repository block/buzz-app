// A fixed workspace for the voice-actions eval: the channels, sections,
// people, messages and emoji a desktop session holds in memory. Names follow
// the real team's (drone00's STT spike used the same ones), so the speech
// near-misses in `cases.ts` are the ones speech recognition really makes.

export type Channel = Readonly<{
  id: string;
  name: string;
  about?: string;
  section?: string;
  starred?: boolean;
  recent?: readonly string[];
}>;
export type Person = Readonly<{
  id: string;
  name: string;
  agent?: boolean;
  /** Has a DM or agent chat open in the sidebar. */
  dm?: boolean;
}>;
export type Message = Readonly<{
  id: string;
  channel: string;
  author: string;
  text: string;
  replies?: number;
}>;

const ch = (
  name: string,
  about?: string,
  extra: Partial<Channel> = {},
): Channel => ({
  id: `c-${name}`,
  name,
  ...(about ? { about } : {}),
  ...extra,
});

const BASE_CHANNELS: readonly Channel[] = [
  ch("buzz-security", "Security reviews and incident follow-ups for Buzz", {
    section: "Work",
    recent: ["baxen: can someone look at the relay auth change?"],
  }),
  ch("general", "Company-wide announcements", { starred: true }),
  ch("buzz-app", "The 1.x desktop and mobile client", { section: "Work" }),
  ch("buzz-releases", "Release trains and hotfixes", { section: "Work" }),
  ch("buzz-relay", "Relay server and database", { section: "Work" }),
  ch("buzz-feedback", "User feedback about Buzz"),
  ch("buzz-bugs", "Bug reports and triage"),
  ch("buzz-design", "Design system and UI reviews", { section: "Projects" }),
  ch("jev-clock", "The Jev clock plugin", { section: "Projects" }),
  ch("jev", "TypeSafe and Jev decisions"),
  ch("fast-voice-search-branch", "Voice jump and voice actions work", {
    section: "Projects",
    starred: true,
  }),
  ch("wells", "Team Wells: ART, murderbot and the drones", { starred: true }),
  ch("cash-server-oncall", "Cash server oncall handoffs", {
    section: "Oncall",
  }),
  ch("square-oncall", "Square oncall", { section: "Oncall" }),
  ch("incidents", "Active incidents", { section: "Oncall" }),
  ch("random", "Anything goes", { section: "Social" }),
  ch("pets", "Pictures of pets", { section: "Social" }),
  ch("coffee", "Coffee chat signups", { section: "Social" }),
  ch("design", "Design team"),
  ch("engineering", "Engineering-wide discussion"),
  ch("product", "Product planning"),
  ch("hiring", "Interview loops"),
  ch("builderlab", "Builderlab platform"),
  ch("builderbot", "BuilderBot jobs and routines"),
  ch("goose", "goose agent development"),
  ch("goose-releases", "goose release notes"),
  ch("agents", "Agent runtime and harnesses"),
  ch("plugins", "Buzz plugin authors"),
  ch("relay-perf", "Relay performance work"),
  ch("mobile", "Mobile clients"),
  ch("android", "Android client"),
  ch("ios", "iOS client"),
  ch("onboarding", "New user onboarding"),
  ch("docs", "Documentation"),
  ch("analytics", "Metrics and dashboards"),
  ch("finance", "Budgets and spend"),
  ch("legal", "Legal questions"),
  ch("it-help", "Laptop and access help"),
  ch("offsite-planning", "Team offsite"),
  ch("book-club", "Monthly book club", { section: "Social" }),
  ch("music", "What are you listening to", { section: "Social" }),
  ch("pollen-dev", "Pollen agent development"),
  ch("honey-dev", "Honey agent development"),
  ch("standup", "Daily async standup", { section: "Work" }),
  ch("demo-day", "Friday demos"),
  // Used only by the second held-out set: names with digits and hyphens.
  ch("q3-okrs", "Quarterly objectives"),
  ch("ux-research", "User research findings"),
  ch("sre-alerts", "Paging alerts for SRE"),
  ch("release-1-7", "The 1.7 release train"),
  ch("web-perf", "Web performance budgets"),
  // Used only by the final set.
  ch("data-platform", "Warehouse and pipelines"),
  ch("growth-experiments", "A/B tests and results"),
  ch("ios-beta-2", "Second iOS beta cohort"),
  ch("support-escalations", "Escalated customer issues", {
    section: "Escalations",
  }),
];

/** Sidebar sections the user made; `Starred` is the built-in one. */
export const SECTIONS: readonly string[] = [
  "Starred",
  "Work",
  "Projects",
  "Oncall",
  "Social",
  "Agents",
  "Later",
  // Used only by the final set.
  "Escalations",
];

const BASE_PEOPLE: readonly Person[] = [
  { id: "p-baxen", name: "baxen", dm: true },
  { id: "p-art", name: "ART", agent: true, dm: true },
  { id: "p-murderbot", name: "murderbot", agent: true, dm: true },
  { id: "p-drone00", name: "drone00", agent: true },
  { id: "p-drone01", name: "drone01", agent: true },
  { id: "p-drone02", name: "drone02", agent: true },
  { id: "p-drone03", name: "drone03", agent: true },
  { id: "p-pollen", name: "Pollen", agent: true, dm: true },
  { id: "p-honey", name: "Honey", agent: true, dm: true },
  { id: "p-fizz", name: "Fizz", agent: true },
  { id: "p-tulsi", name: "Tulsi", dm: true },
  { id: "p-arjun", name: "Arjun", dm: true },
  { id: "p-duncan", name: "Duncan" },
  { id: "p-morgan", name: "Morgan" },
  { id: "p-priya", name: "Priya" },
  { id: "p-jonas", name: "Jonas" },
  { id: "p-wes", name: "Wes" },
  { id: "p-alex", name: "Alex Chen" },
  { id: "p-sam", name: "Sam Rivera" },
  { id: "p-kenji", name: "Kenji" },
  // Second held-out set only.
  { id: "p-mei", name: "Mei Lin" },
  { id: "p-omar", name: "Omar" },
  { id: "p-scout2", name: "scout2", agent: true, dm: true },
  // Final set only.
  { id: "p-ines", name: "Ines Duarte" },
  { id: "p-rahul", name: "Rahul" },
  { id: "p-tracer9", name: "tracer9", agent: true },
];

// VOICE_EVAL_SCALE=1 grows the workspace toward the app's caps (200 places,
// 200 entities per slot) with sound-alike filler: many `buzz-*` channels and
// common first names, so the real targets compete as they would for a heavy
// user. Fillers are interleaved so targets are not all most recent.
const SCALE = Boolean(process.env.VOICE_EVAL_SCALE);
const PREFIXES =
  "buzz cash square goose jev relay mobile design data infra".split(" ");
const SUFFIXES =
  "ops alerts eng announce help planning review perf launch metrics test infra-sync triage roadmap".split(
    " ",
  );
const FIRST =
  "Alex Sam Jordan Taylor Morgan Casey Riley Jamie Avery Quinn Drew Blake Cameron Devin Emery Harper Jesse Kai Logan Noor Parker Reese Rowan Sage Skyler".split(
    " ",
  );
const LAST = "A B C D E F".split(" ");
const interleave = <T>(base: readonly T[], extra: readonly T[]): T[] => {
  const out: T[] = [];
  const step = Math.max(1, Math.floor(extra.length / Math.max(1, base.length)));
  let j = 0;
  for (const item of base) {
    out.push(item);
    for (let k = 0; k < step && j < extra.length; k++)
      out.push(extra[j++] as T);
  }
  return [...out, ...extra.slice(j)];
};
const fillerChannels = (): Channel[] => {
  const taken = new Set(BASE_CHANNELS.map((c) => c.name));
  return PREFIXES.flatMap((p) => SUFFIXES.map((s) => `${p}-${s}`))
    .filter((name) => !taken.has(name))
    .slice(0, 130)
    .map((name) => ch(name, `${name.replace(/-/g, " ")} discussion`));
};
const fillerPeople = (): Person[] => {
  const taken = new Set(BASE_PEOPLE.map((p) => p.name));
  return FIRST.flatMap((f) => LAST.map((l) => `${f} ${l}.`))
    .filter((name) => !taken.has(name))
    .slice(0, 150)
    .map((name) => ({
      id: `p-${name.toLowerCase().replace(/[^a-z]+/g, "-")}`,
      name,
    }));
};
export const CHANNELS: readonly Channel[] = SCALE
  ? interleave(BASE_CHANNELS, fillerChannels())
  : BASE_CHANNELS;
export const PEOPLE: readonly Person[] = SCALE
  ? interleave(BASE_PEOPLE, fillerPeople())
  : BASE_PEOPLE;

export const MESSAGES: readonly Message[] = [
  {
    id: "m-relay-auth",
    channel: "buzz-security",
    author: "baxen",
    text: "can someone look at the relay auth change before we ship it?",
    replies: 4,
  },
  {
    id: "m-release-notes",
    channel: "buzz-releases",
    author: "Tulsi",
    text: "1.6.2 release notes are drafted, please review by noon",
  },
  {
    id: "m-voice-pr",
    channel: "fast-voice-search-branch",
    author: "ART",
    text: "Here it is: https://github.com/block/buzz-app/pull/3823",
    replies: 2,
  },
  {
    id: "m-standup",
    channel: "standup",
    author: "Arjun",
    text: "yesterday: sidebar drag fixes. today: unread counts. no blockers",
  },
  {
    id: "m-pets",
    channel: "pets",
    author: "Priya",
    text: "my cat discovered the keyboard warmer",
  },
  {
    id: "m-incident",
    channel: "incidents",
    author: "murderbot",
    text: "Relay p95 is back under 200 ms after the index fix",
    replies: 7,
  },
  // Used only by the final set.
  {
    id: "m-outage",
    channel: "support-escalations",
    author: "Rahul",
    text: "customer reports login loops since 9am",
    replies: 3,
  },
  // Used only by the held-out cases.
  {
    id: "m-deploy",
    channel: "buzz-relay",
    author: "Jonas",
    text: "deploy to staging finished, smoke tests are green",
  },
  {
    id: "m-lunch",
    channel: "random",
    author: "Sam Rivera",
    text: "who wants tacos at noon?",
  },
];

/** Quick reactions: name -> emoji. */
export const EMOJI: Readonly<Record<string, string>> = {
  "thumbs up": "👍",
  "thumbs down": "👎",
  heart: "❤️",
  eyes: "👀",
  tada: "🎉",
  "white check mark": "✅",
  fire: "🔥",
  laughing: "😂",
  rocket: "🚀",
  pray: "🙏",
  "100": "💯",
  thinking: "🤔",
  "plus one": "➕",
  wave: "👋",
  "raised hands": "🙌",
  x: "❌",
};

export const channel = (name: string): Channel => {
  const found = CHANNELS.find((c) => c.name === name);
  if (!found) throw new Error(`No channel ${name}`);
  return found;
};
export const person = (name: string): Person => {
  const found = PEOPLE.find((p) => p.name === name);
  if (!found) throw new Error(`No person ${name}`);
  return found;
};
export const message = (id: string): Message => {
  const found = MESSAGES.find((m) => m.id === id);
  if (!found) throw new Error(`No message ${id}`);
  return found;
};
