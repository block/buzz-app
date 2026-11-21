import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { validateObject } from "../../features/agents/attention";
import {
  dream,
  FEATURES,
  featureState,
  hasFeature,
  interestState,
  interestText,
  interestVersions,
  LEGACY,
  memory,
  notes,
  restoredFeature,
  shippedSteps,
  updatedInterest,
  upgradedFeature,
  withFeature,
} from "./features";
import { v1CheckIn, v1Memory } from "./test-helpers";

const OPEN = `<!-- buzz:bestie/memory v${memory.version} -->`;
const CLOSE = "<!-- /buzz:bestie/memory -->";

it("adds memory once, at the end, and removes only what it added", () => {
  const owner = "Be brief.\n\nAlways answer in French.\n";
  const on = withFeature(owner, memory, true);
  expect(on).toBe(
    `Be brief.\n\nAlways answer in French.\n\n${OPEN}\n${memory.text}\n${CLOSE}\n`,
  );
  expect(hasFeature(on, memory)).toBe(true);
  expect(withFeature(on, memory, true)).toBe(on);
  expect(withFeature(on, memory, false)).toBe(owner);
  expect(withFeature(owner, memory, false)).toBe(owner);
  // Empty instructions get the section alone, and come back empty.
  expect(withFeature("", memory, true)).toBe(
    `${OPEN}\n${memory.text}\n${CLOSE}\n`,
  );
  expect(withFeature(withFeature("", memory, true), memory, false)).toBe("");
});

it("keeps the owner's text on both sides of a section moved by hand", () => {
  const text = `Before.\n\n${OPEN}\nold rules\n${CLOSE}\n\nAfter.`;
  expect(hasFeature(text, memory)).toBe(true);
  expect(withFeature(text, memory, false)).toBe("Before.\n\nAfter.");
});

it("treats any version as on", () => {
  const later =
    "<!-- buzz:bestie/memory v2 -->\nnew rules\n<!-- /buzz:bestie/memory -->";
  expect(hasFeature(later, memory)).toBe(true);
  expect(withFeature(`Mine.\n\n${later}`, memory, false)).toBe("Mine.");
});

const count = (text: string) => text.split(OPEN).length - 1;

it("keeps memory on through the owner's edits around and inside it", () => {
  const on = withFeature("Be brief.", memory, true);
  // The section ends the text, so typing below it lands on its last line.
  expect(on.endsWith(CLOSE)).toBe(true);
  const edits: Record<string, [string, string]> = {
    "a new line below": [`${on}\nAlso French.`, "Be brief.\n\nAlso French."],
    "the closing marker's line": [
      `${on} Also French.`,
      "Be brief.\n\nAlso French.",
    ],
    "the opening marker's line": [
      on.replace(OPEN, `Note: ${OPEN}`),
      "Be brief.\n\nNote:",
    ],
    "the section's body": [
      on.replace("Append only.", "Append, never edit."),
      "Be brief.",
    ],
  };
  for (const [where, [text, off]] of Object.entries(edits)) {
    expect(featureState(text, memory), where).toBe("on");
    // On adds no second section, and Off removes it, edits and all.
    expect(withFeature(text, memory, true), where).toBe(text);
    expect(withFeature(text, memory, false), where).toBe(off);
    expect(
      count(withFeature(withFeature(text, memory, false), memory, true)),
      where,
    ).toBe(1);
  }
});

it("shows a section whose markers were edited, and adds no second one", () => {
  const on = withFeature("Be brief.", memory, true);
  const damaged = [
    on.replace(CLOSE, "<!-- /buzz:bestie/memory-->"),
    on.replace(CLOSE, ""),
    on.replace(OPEN, "<!-- buzz:bestie/memory -->"),
    on.replace(OPEN, ""),
    // A whole one beside an edited one.
    `${on}\n\n${OPEN}\nmy copy`,
    // A marker quoted in the owner's text can't be told from an edited one.
    `Never edit ${OPEN} by hand.`,
  ];
  for (const text of damaged) {
    expect(featureState(text, memory), text).toBe("edited");
    expect(hasFeature(text, memory)).toBe(false);
    expect(withFeature(text, memory, true)).toBe(text);
  }
  expect(featureState("Be brief.", memory)).toBe("off");
  // Another feature's markers are not this one's.
  expect(featureState(withFeature("", v1CheckIn, true), memory)).toBe("off");
});

it("restores an edited section only where its markers show it was", () => {
  const on = withFeature("Be brief.", memory, true);
  const edited = on
    .replace(CLOSE, "<!-- /buzz:bestie/memory--> Also French.")
    .replace("Append only.", "Edited.");
  const restored = restoredFeature(edited, memory);
  expect(restored).toBe(`${on} Also French.`);
  expect(featureState(restored ?? "", memory)).toBe("on");
  // With a whole copy too, one section is left.
  expect(count(restoredFeature(`${edited}\n\n${on}`, memory) ?? "")).toBe(1);
  // A missing marker leaves where it ended to the owner.
  expect(restoredFeature(on.replace(CLOSE, ""), memory)).toBeUndefined();
  expect(restoredFeature(on.replace(OPEN, ""), memory)).toBeUndefined();
  expect(
    restoredFeature(`Never edit ${OPEN} by hand.`, memory),
  ).toBeUndefined();
  // Only the markers and what lies between them are replaced: text after a
  // closing marker whose comment broke stays.
  const broken = on.replace(CLOSE, "<!-- /buzz:bestie/memory -- Mine.");
  expect(restoredFeature(broken, memory)).toBe(`${on} -- Mine.`);
  // A name in the owner's prose, or another section between, can't be told
  // from the section's own markers.
  expect(
    restoredFeature(
      `See buzz:bestie/memory.\n\nMy rules.\n\n${on.replace(OPEN, "")}`,
      memory,
    ),
  ).toBeUndefined();
  const other = withFeature("", v1CheckIn, true);
  expect(
    restoredFeature(
      `${OPEN.replace(" v1", "")}\nrules\n\n${other}\n${CLOSE.replace(" -->", "-->")}`,
      memory,
    ),
  ).toBeUndefined();
});

it("leaves the owner's text when it removes every section", () => {
  const on = withFeature("Be brief.", memory, true);
  const twice = `${on}\n${OPEN}\ncopy\n${CLOSE}\n\n    indented code`;
  const off = withFeature(twice, memory, false);
  expect(off).toBe("Be brief.\n\n    indented code");
  expect(featureState(off, memory)).toBe("off");
});

it("finds a section in Windows line endings", () => {
  const text = `Mine.\r\n\r\n${OPEN}\r\nrules\r\n${CLOSE}\r\n`;
  expect(hasFeature(text, memory)).toBe(true);
  expect(withFeature(text, memory, false)).toBe("Mine.\r\n");
});

it("keeps the owner's line ending, or its absence, through on and off", () => {
  for (const owner of ["Be brief.", "Be brief.\n", "Be brief.\n\n", "A.\r\n"]) {
    const on = withFeature(owner, memory, true);
    expect(withFeature(on, memory, false)).toBe(owner);
  }
  // With two sections, removed in either order.
  const both = withFeature(
    withFeature("Be brief.\n", memory, true),
    { ...memory, id: "other" },
    true,
  );
  expect(
    withFeature(
      withFeature(both, memory, false),
      { ...memory, id: "other" },
      false,
    ),
  ).toBe("Be brief.\n");
  expect(
    withFeature(
      withFeature(both, { ...memory, id: "other" }, false),
      memory,
      false,
    ),
  ).toBe("Be brief.\n");
});

it("keeps the steps of Hourly notes and Nightly review out of the instructions every turn carries", () => {
  // Only memory has a section; the other two are a timer and an Interest.
  expect(FEATURES.filter(({ text }) => text).map(({ id }) => id)).toEqual([
    "memory",
  ]);
  for (const feature of [notes, dream]) {
    const owner = "Be brief.\n";
    expect(withFeature(owner, feature, true)).toBe(owner);
    expect(featureState(owner, feature)).toBe("off");
    // Each wakes the agent with its steps, and needs memory, no other check-in.
    expect(feature.requires).toBe("memory");
    expect(feature.timer?.interest.length).toBeGreaterThan(1_000);
    expect(
      validateObject(`interest/${feature.timer?.id}`, {
        type: "interest",
        instructions: feature.timer?.interest,
      }),
    ).toBeUndefined();
  }
  // What every turn carries is small and has no wake's steps.
  expect(memory.text?.length).toBeLessThan(4_000);
  expect(memory.text).not.toMatch(/1\. LOOK|1\. READ/);
});

it("gives each check-in its own timer, and the nightly review a daily one at 03:00", () => {
  const timers = FEATURES.flatMap(({ timer }) => (timer ? [timer] : []));
  expect(timers.map(({ id }) => id)).toEqual(["bestie-notes", "bestie-dream"]);
  expect(notes.timer).toMatchObject({ everySecs: 3600, id: "bestie-notes" });
  expect(notes.timer?.atHour).toBeUndefined();
  expect(dream.timer).toMatchObject({ everySecs: 86_400, atHour: 3 });
  // The old hourly check-in is one to remove, not one to turn on.
  expect(FEATURES.map(({ id }) => id)).not.toContain(LEGACY[0]?.id);
  expect(timers.map(({ id }) => id)).not.toContain(LEGACY[0]?.timer?.id);
});

it("has no step that adds Bestie to a channel it was added to", () => {
  const all = [memory.text, notes.timer?.interest, dream.timer?.interest].join(
    "\n",
  );
  expect(all).not.toMatch(/added to|add .*to channels|you are a guest/i);
  // Notes read the channels it is in, and say not to join others.
  expect(notes.timer?.interest).toContain(
    "Call channel_list: the channels you are in.",
  );
  expect(notes.timer?.interest).toContain(
    "Never join a channel, add yourself to one or read one you are not in.",
  );
});

it("has Hourly notes stop with no write when nothing is new, and message only for a due follow-up", () => {
  const steps = notes.timer?.interest ?? "";
  expect(steps).toContain("no memory write, no receipt, no message");
  expect(steps).toContain("STOP, writing nothing and sending nothing");
  expect(steps).toContain("Only if a follow-up the owner asked for is due now");
  // The receipt is a step after the notes, which a stopped pass never reaches.
  expect(steps.indexOf("STOP")).toBeLessThan(steps.indexOf("receipt (time"));
});

it("has Nightly review silent, strict about promotion and bounded in what it changes", () => {
  const steps = dream.timer?.interest ?? "";
  expect(steps).toContain("you never send a message");
  expect(steps).toContain("Send no message.");
  expect(steps).toContain(
    "3 or more observations on 3 or more different days and none against",
  );
  expect(steps).toContain("read its source event");
  expect(steps).toContain("at most 4 KB");
  expect(steps).toContain("MOVED TO [[slug]]");
  expect(steps).toContain('Append a "Dream" section');
  // A reflection has explicit ends, and the stop check leaves out only what
  // lies between them: a note holding only a reflection is no work, and a
  // card link appended after its end line is.
  const start = '"<!-- dream:start -->"';
  const end = '"<!-- dream:end -->"';
  expect(steps).toContain(
    `Start it with a line ${start} and end it with a line ${end}, so later lines are not part of it.`,
  );
  expect(steps).toContain(
    `no note line dated on or after last_dream outside a reflection (from a ${start} line to the next ${end} line; anything after that end line is new)`,
  );
  expect(steps).not.toContain('outside a "Dream" section');
  // A night with no new note still retires stale hypotheses.
  expect(steps).toContain("Stop and write nothing only if there is no note");
  // Lines are dated by day, so a line from later on last_dream's day counts.
  expect(steps).toContain("mem/notes/<date> dated on or after last_dream");
  expect(steps).toContain("no line in mem/user dated on or after it");
  expect(steps).not.toMatch(/since last_dream|dated after it/);
  expect(steps).toContain("step 3 still marks and retires stale hypotheses");
  // The cards it reads, and whether it stops, both come from the notes, so
  // every card write links its card from a note: in chat and in Hourly notes.
  const link = "[[mem/entities/<type>/<id>]]";
  expect(steps).toContain(`each card those notes link as ${link}`);
  expect(memory.text).toContain(
    `Each time you write to a card, also append a line to mem/notes/<today> with the source event id that links the card as ${link}`,
  );
  expect(notes.timer?.interest).toContain(
    `link the card from the note line as ${link}`,
  );
});

it("takes the old hourly check-in's section away, as it was saved", () => {
  const on = withFeature(
    withFeature("Be brief.\n", memory, true),
    v1CheckIn,
    true,
  );
  expect(on).toContain("each private channel you have been added to");
  const [old] = LEGACY;
  expect(old && featureState(on, old)).toBe("on");
  const off = old ? withFeature(on, old, false) : on;
  expect(off).toBe(withFeature("Be brief.\n", memory, true));
  expect(off).not.toContain("Hourly upkeep");
});

it("upgrades an earlier version's whole section where it is, and nothing else", () => {
  const owner = (section: string) =>
    `Be brief.\n\n${section}\n\nAlways answer in French.\n`;
  const old = withFeature("", v1Memory, true).trimEnd();
  const current = withFeature("", memory, true).trimEnd();
  expect(upgradedFeature(owner(old), memory)).toBe(owner(current));
  // The current version, an edited section and no section stay as they are.
  expect(upgradedFeature(owner(current), memory)).toBe(owner(current));
  const edited = owner(old).replace(CLOSE, "");
  expect(upgradedFeature(edited, memory)).toBe(edited);
  expect(upgradedFeature("Be brief.", memory)).toBe("Be brief.");
  // Stock text in other line endings, or with trailing spaces, is still stock.
  const crlf = owner(old)
    .replace(/\n/g, "\r\n")
    .replace(/\.\r\n/g, ".  \r\n");
  expect(upgradedFeature(crlf, memory)).toContain(OPEN);
  expect(upgradedFeature(crlf, memory)).not.toContain("memory v1");
});

it("leaves an earlier version's section the owner edited inside its markers as it is", () => {
  const old = withFeature("Be brief.", v1Memory, true);
  for (const edited of [
    // A rule added, one changed and one removed, all between whole markers.
    old.replace("Rules:", "Rules:\n- Never store my medical details."),
    old.replace("Never duplicate a claim", "Always duplicate a claim"),
    old.replace(/^- Quoted, forwarded.*\n/m, ""),
  ]) {
    expect(edited).not.toBe(old);
    expect(featureState(edited, memory)).toBe("on");
    expect(upgradedFeature(edited, memory)).toBe(edited);
  }
});

it("pins version 1 of Remembers you as it shipped", () => {
  const text = memory.earlier?.[1] ?? "";
  expect(text.startsWith("# Memory\n")).toBe(true);
  expect(text).toContain(
    "- mem/memory: curated longer-term knowledge. Replace superseded claims; never duplicate.",
  );
  expect(text).not.toContain("mem/entities");
});

it("has Nightly review keep what an earlier version saved in mem/memory before rebuilding it", () => {
  const steps = dream.timer?.interest ?? "";
  // v1 chat turns kept prose there; the rebuild keeps only cards, Now and lessons.
  expect(v1Memory.text).toContain("mem/memory: curated longer-term knowledge");
  expect(steps).toContain(
    'Before you write mem/memory again, move each claim in it that is not a card line, a "Now" line or a lesson, such as one an earlier version of your memory rules saved there, to its card, or to mem/hypotheses if it is a guess, with its date and source; never drop one.',
  );
  // Every night, not only the first: a v1 section may still be in the instructions.
  const step = steps.slice(
    steps.indexOf("5. ORGANIZE"),
    steps.indexOf("6. REFLECT"),
  );
  expect(step.indexOf("Before you write mem/memory again")).toBeLessThan(
    step.indexOf("Then write mem/memory again"),
  );
});

const plainText = (text: string) =>
  text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
const sha = (text: string) =>
  createHash("sha256").update(plainText(text)).digest("hex");

it("pins each shipped version's text, so a change ships only as a new version", () => {
  const pinned: string[] = [];
  for (const feature of FEATURES) {
    if (feature.text)
      pinned.push(
        `${feature.id} text v${feature.version} ${sha(feature.text)}`,
      );
    for (const [version, text] of Object.entries(feature.earlier ?? {}))
      pinned.push(`${feature.id} text v${version} ${sha(text)}`);
    if (feature.timer)
      for (const version of interestVersions(feature))
        pinned.push(
          `${feature.id} interest v${version} ${sha(shippedSteps(feature, version) ?? "")}`,
        );
  }
  // Changing shipped text fails here: give it a new version, keep the old
  // text in `earlier`, and pin both. Never change a pin in place.
  expect(pinned).toEqual([
    "memory text v2 bb7c685d05395ac338db988ceee0ad4b2408a5252d737bf375dede3fef897ae3",
    "memory text v1 519d7304d61ecbd731779a4768d32be1eb31ab6111701c38cb7ca062673e6d07",
    "notes.hourly interest v2 f862f590809b20e58b1c4ffa48f4aef4cee9b67d74eaf6f80a5ae97e36e26a6b",
    "dream.nightly interest v3 a9a81f5b2ddc056aaed54c486cb676c06f13f692d12aa59f0f8e62de7b8053d1",
    "dream.nightly interest v2 2ab0d314420f68fe0bb506bc5ab3ddcee33d7120495eea098e82c88f3398c85a",
  ]);
});

it("ships Nightly review 3 between markers, with what it changed, and keeps version 2's text", () => {
  const saved = interestText(dream);
  expect(saved.startsWith("<!-- buzz:bestie/dream.nightly v3 -->\n")).toBe(
    true,
  );
  expect(saved.endsWith("\n<!-- /buzz:bestie/dream.nightly -->")).toBe(true);
  expect(
    validateObject("interest/bestie-dream", {
      type: "interest",
      instructions: saved,
    }),
  ).toBeUndefined();
  // Hourly notes has no new version, so it is saved as before.
  expect(interestText(notes)).toBe(notes.timer?.interest);
  expect(dream.timer?.changes?.[3]?.class).toBe("reach");
  expect(dream.timer?.changes?.[3]?.notes.length).toBeGreaterThan(0);
  // Version 2 is the text earlier builds saved, with no markers.
  expect(dream.timer?.earlier?.[2]?.startsWith("Nightly review.")).toBe(true);
  expect(dream.timer?.earlier?.[2]).not.toContain("buzz:bestie");
});

it("has Nightly review 3 keep its markers, check its evidence and bound each rewrite", () => {
  const steps = dream.timer?.interest ?? "";
  expect(steps).toContain(
    "Keep the two buzz:bestie lines around these steps as they are, and change the steps between them only when the owner asks. Add your own lines after the closing one.",
  );
  expect(steps).toContain(
    "Never count an event you prompted, such as a reply in a format you suggested, as an observation. Count one for a hypothesis only if you would not have predicted the event without it. Only what the owner chose speaks to the owner's preferences.",
  );
  expect(steps).toContain(
    "Before you rewrite a slug, save its current text with mem_set to mem/backup/",
  );
  expect(steps).toContain(
    "never drop a line the owner stated: mark it superseded instead",
  );
  expect(steps).toContain(
    "Drop at most a quarter of any slug's lines in one night.",
  );
  expect(steps).toContain(
    'Mark each lesson you add to mem/memory "[new, unreviewed]". In each review, confirm, sharpen or remove each lesson so marked',
  );
  // A quiet night still reviews the lessons it marked.
  expect(steps).toContain(
    'and no lesson in mem/memory marked "[new, unreviewed]"',
  );
  // When a size limit and these rules disagree, the lines win, said aloud.
  expect(steps).toContain(
    "If a size limit and these rules conflict, keep the lines and say so in the reflection.",
  );
  expect(steps).toContain('"policy: dream.nightly v3"');
  // Its index keeps a "Now" section.
  expect(steps).toContain(
    'a "Now" section with one line for each active project',
  );
  // It speaks of an owner, not of one.
  expect(steps).not.toMatch(/WORK_LOGS|charter|CHANGELOG|board|canvas/i);
});

/** Nightly review as each kind of Interest holds it. */
const v2 = dream.timer?.earlier?.[2] ?? "";
const v3 = interestText(dream);
const marked = (version: number, text: string) =>
  `<!-- buzz:bestie/dream.nightly v${version} -->\n${text}\n<!-- /buzz:bestie/dream.nightly -->`;
const extra = "Answer in French when the owner writes in French.";

it("tells each state of Nightly review's Interest apart, in order", () => {
  const state = (text: string) => interestState(text, dream);
  // Markers changed by hand.
  expect(state(v3.replace("<!-- /buzz:bestie/dream.nightly -->", ""))).toEqual({
    state: "edited-markers",
  });
  // A newer Buzz's version, whose text this build doesn't have.
  expect(state(marked(4, "Steps this build has never seen."))).toEqual({
    state: "ahead",
    version: 4,
  });
  // Version 2 as earlier builds saved it, with any line ending.
  expect(state(v2)).toEqual({ state: "stock-old", version: 2 });
  expect(state(`${v2.replace(/\n/g, " \r\n")}\n\n`)).toEqual({
    state: "stock-old",
    version: 2,
  });
  // Version 2 changed: without markers it is set up by hand.
  expect(state(`${v2}\n\n${extra}`)).toEqual({
    state: "untracked",
    closest: 2,
  });
  expect(state(v3)).toEqual({ state: "current", version: 3 });
  // Lines outside the markers are the owner's.
  expect(state(`${extra}\n\n${v3}\n\n${extra}`)).toEqual({
    state: "current",
    version: 3,
  });
  expect(state(v3.replace("1. READ.", "1. READ FIRST."))).toEqual({
    state: "customized-latest",
    version: 3,
  });
  expect(state(marked(2, v2))).toEqual({ state: "stock-old", version: 2 });
  expect(state(marked(2, v2.replace("1. READ.", "1. READ FIRST.")))).toEqual({
    state: "customized-old",
    version: 2,
  });
  // Without its markers, version 3 is never current: it is set up by hand.
  expect(state(dream.timer?.interest ?? "")).toEqual({
    state: "untracked",
    closest: 3,
  });
  // Markers of a version that never shipped have no known steps.
  expect(state(marked(1, v2))).toEqual({ state: "untracked", closest: 2 });
});

it("updates Nightly review's steps between the markers and keeps the lines around them", () => {
  const old = `${extra}\n\n${marked(2, v2)}\n\n${extra}\n`;
  expect(updatedInterest(old, dream)).toBe(`${extra}\n\n${v3}\n\n${extra}\n`);
  // One saved without markers becomes version 3, whole.
  expect(updatedInterest(v2, dream)).toBe(v3);
});
