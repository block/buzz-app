import { expect, it } from "vitest";
import type { KeyBinding } from "./bindings";
import { parseChord, searchEntry, shortcutFilter } from "./search";

it.each<[string, boolean, KeyBinding | undefined]>([
  // As shown on each platform.
  ["⌘K", true, { key: "k", mod: true }],
  ["⇧⌘K", true, { key: "k", mod: true, shift: true }],
  [
    "⌃⌥⇧⌘↑",
    true,
    { key: "ArrowUp", ctrl: true, alt: true, shift: true, mod: true },
  ],
  ["Ctrl+Shift+A", false, { key: "a", mod: true, shift: true }],
  ["Alt+Shift+↓", false, { key: "ArrowDown", alt: true, shift: true }],
  ["Ctrl+PageUp", false, { key: "PageUp", mod: true }],
  ["F8", false, { key: "f8" }],
  ["Space", true, { key: " " }],
  // As typed, in any case and spacing.
  ["cmd k", true, { key: "k", mod: true }],
  ["Command+Shift+O", true, { key: "o", mod: true, shift: true }],
  ["ctrl+shift+a", false, { key: "a", mod: true, shift: true }],
  // Control is its own modifier on Apple platforms.
  ["ctrl a", true, { key: "a", ctrl: true }],
  ["opt f", true, { key: "f", alt: true }],
  ["shift esc", false, { key: "Escape", shift: true }],
  ["cmd up", true, { key: "ArrowUp", mod: true }],
  ["e", true, { key: "e" }],
  // Plus separates, unless it is the key.
  ["⌘+", true, { key: "+", mod: true }],
  ["Ctrl++", false, { key: "+", mod: true }],
  ["Ctrl+-", false, { key: "-", mod: true }],
  ["+", false, { key: "+" }],
  ["ctrl+", false, undefined],
  // Not one key: names and half-typed chords.
  ["", true, undefined],
  ["cmd", true, undefined],
  ["⇧⌘", true, undefined],
  ["focus", true, undefined],
  ["cmd k j", true, undefined],
])("parses %j (Apple %s)", (query, apple, chord) => {
  expect(parseChord(query, apple)).toEqual(chord);
});

const rows = (apple: boolean) =>
  [
    ["Search Buzz", "Buzz", [{ key: "k", mod: true }]],
    [
      "Code",
      "Message formatting",
      [
        { key: "e", mod: true },
        { key: "c", mod: true, shift: true },
      ],
    ],
    [
      "Increase interface size",
      "Buzz",
      [
        { key: "=", mod: true },
        { key: "+", mod: true, shift: true },
      ],
    ],
    [
      "Add or edit link",
      "Message formatting",
      [
        { key: "k", mod: true },
        { key: "u", mod: true, shift: true },
      ],
    ],
    [
      "Open unread in Activity",
      "Inbox",
      [{ key: "a", mod: true, shift: true }],
    ],
    ["Edit selected message", "Buzz", [{ key: "e" }]],
  ].map(([title, group, chords]) => ({
    title,
    entry: searchEntry(
      title as string,
      group as string,
      chords as KeyBinding[],
      apple,
    ),
  }));

it.each<[string, boolean, readonly string[]]>([
  // Names and groups, including a plugin's.
  ["search", true, ["Search Buzz"]],
  ["inbox", true, ["Open unread in Activity"]],
  ["FORMATTING", false, ["Code", "Add or edit link"]],
  // A whole chord matches exactly, with each alias.
  ["⌘K", true, ["Search Buzz", "Add or edit link"]],
  ["Ctrl+K", false, ["Search Buzz", "Add or edit link"]],
  ["cmd shift u", true, ["Add or edit link"]],
  ["ctrl+shift+a", false, ["Open unread in Activity"]],
  ["⇧⌘C", true, ["Code"]],
  // Layout-aware: either side of a shifted pair finds the key.
  ["⌘+", true, ["Increase interface size"]],
  ["ctrl =", false, ["Increase interface size"]],
  // A single letter is a plain key and also finds names containing it.
  ["L", true, ["Add or edit link", "Edit selected message"]],
  // Modifiers alone, whole or half-typed, find the shown chords holding them;
  // the hidden ⇧⌘+ alias does not make "Increase interface size" a match.
  ["⇧⌘", true, ["Code", "Add or edit link", "Open unread in Activity"]],
  [
    "Ctrl+Shift",
    false,
    ["Code", "Add or edit link", "Open unread in Activity"],
  ],
  ["cmd shift", true, ["Code", "Add or edit link", "Open unread in Activity"]],
  [
    "ctrl+",
    false,
    [
      "Search Buzz",
      "Code",
      "Increase interface size",
      "Add or edit link",
      "Open unread in Activity",
    ],
  ],
  // A whole chord never matches one that differs by Shift.
  ["⇧⌘K", true, []],
  ["⇧⌘=", true, ["Increase interface size"]],
  ["⇧⌘E", true, []],
  ["nothing here", true, []],
  ["⌘X", true, []],
])("text %j (Apple %s) finds %j", (text, apple, expected) => {
  const { matches } = shortcutFilter({ kind: "text", text }, apple);
  expect(
    rows(apple)
      .filter(({ entry }) => matches(entry))
      .map(({ title }) => title),
  ).toEqual(expected);
});

it("recorded keys find chords only, not names containing the key", () => {
  const { chord, matches } = shortcutFilter(
    { kind: "keys", chord: { key: "e" }, code: "KeyE" },
    true,
  );
  expect(chord).toEqual({ key: "e" });
  expect(
    rows(true)
      .filter(({ entry }) => matches(entry))
      .map(({ title }) => title),
  ).toEqual(["Edit selected message"]);
  // A key recorded with Shift finds its unshifted alias too.
  const shifted = shortcutFilter(
    {
      kind: "keys",
      chord: { key: "+", mod: true, shift: true },
      code: "Equal",
    },
    true,
  );
  expect(
    rows(true)
      .filter(({ entry }) => shifted.matches(entry))
      .map(({ title }) => title),
  ).toEqual(["Increase interface size"]);
});
