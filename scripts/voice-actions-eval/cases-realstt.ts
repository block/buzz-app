// Real recognizer output (`--set realstt`): drone00's Apple on-device
// transcripts of synthetic speech (RESEARCH/VOICE_APPLE_STT_TRANSCRIPTS.tsv),
// the final text with the app's 25 name hints, exactly as returned. Each is
// paired with a hover and the action that was meant. Repeats of the same
// transcript are kept once; "show me the pollen channel" and "open drone02"
// are left out, since this workspace has no one place they clearly mean.
import type { Case, Category, Expected } from "./cases";

const act = (action: string, owner?: string, target?: string): Expected => ({
  action,
  ...(owner ? { owner } : {}),
  ...(target ? { target } : {}),
});
const go = (navigate: string): Expected => ({ navigate });

type Row = [Category, string | null, string, Expected];

const ROWS: Row[] = [
  // a01, p1: "take me to buzz security", with the hyphen the hint added.
  ["navigate", null, "Take me to buzz-security", go("channel:c-buzz-security")],
  // a13: the same with a 400 ms pause before the name; the hint lost.
  ["stt", null, "Take me to bus security", go("channel:c-buzz-security")],
  // a02, p2
  ["navigate", null, "Open the Wells channel", go("channel:c-wells")],
  // a03, a04 (said "backsen"), p3
  ["stt", null, "Go to my DM with vaccine", go("dm:d-baxen")],
  // baxen3 (Daniel)
  ["navigate", null, "Go to my DM with baxen", go("dm:d-baxen")],
  // baxen1: the name alone.
  ["stt", null, "Vaccine", go("dm:d-baxen")],
  // baxen2: messaging someone with a DM open is going to it.
  ["stt", null, "Message vaccine", go("dm:d-baxen")],
  // a04, a14 (500 ms pause)
  [
    "forward",
    "message:m-relay-auth",
    "Send this to murderbot",
    act("message.forward_to_person", "m-relay-auth", "p-murderbot"),
  ],
  // p5
  [
    "stt",
    "message:m-incident",
    "Send this to my Durbant",
    act("message.forward_to_person", "m-incident", "p-murderbot"),
  ],
  // a05
  [
    "stt",
    "message:m-voice-pr",
    "Forward this to drone 02",
    act("message.forward_to_person", "m-voice-pr", "p-drone02"),
  ],
  // a06: "star" with the hint still comes out "start".
  ["stt", "#buzz-app", "Start this channel", act("channel.star", "c-buzz-app")],
  // a07
  [
    "reverse",
    "#legal",
    "Pin this channel to favorites",
    act("channel.star", "c-legal"),
  ],
  // a08
  [
    "forward",
    "#buzz-feedback",
    "Move this to the work section",
    act("channel.move_to_section", "c-buzz-feedback", "s-Work"),
  ],
  // a09
  [
    "forward",
    "message:m-pets",
    "React with thumbs up",
    act("message.react", "m-pets", "e-thumbs up"),
  ],
  // a10
  [
    "forward",
    "message:m-incident",
    "Follow this thread",
    act("message.follow", "m-incident"),
  ],
  // a11, p4
  [
    "navigate",
    null,
    "Jump to cash server oncall",
    go("channel:c-cash-server-oncall"),
  ],
  // a15 (700 ms pause)
  [
    "navigate",
    null,
    "Open fast-voice-search-branch",
    go("channel:c-fast-voice-search-branch"),
  ],
  // p8
  [
    "navigate",
    null,
    "Take me to fast-voice-search-branch",
    go("channel:c-fast-voice-search-branch"),
  ],
  // Appended, so earlier ids stay put.
  // drone00's hint run before the ordinary-word filter: hints "star" and
  // "general" turned "star this channel" into this. They meant the hovered one.
  ["stt", "#buzz-app", "Star this general", act("channel.star", "c-buzz-app")],
  ["stt", "#legal", "Star this general", act("channel.star", "c-legal")],
];

export const REALSTT: readonly Case[] = ROWS.map(
  ([category, hover, spoken, expect], i) => ({
    id: `realstt-${category}-${String(i + 1).padStart(3, "0")}`,
    category,
    hover,
    spoken,
    expect,
  }),
);
