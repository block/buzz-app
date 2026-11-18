// Builds the base prompt from its sections. The host picks each section's
// text before the model sees it, so the prompt states one rule per topic.
import { type Facts, LAYOUT, locked, SECTIONS, type Section } from "./index";

/** Tells two texts apart; not for security. 64-bit FNV-1a, so composing stays
 * synchronous. */
function hash(text: string) {
  let value = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text))
    value = BigInt.asUintN(64, (value ^ BigInt(byte)) * 0x100000001b3n);
  return value.toString(16).padStart(16, "0");
}

type Printed = Readonly<{ section: Section; body: string }>;
const bodies = (facts: Facts): Printed[] =>
  SECTIONS.map((section) => ({
    section,
    body: (typeof section.text === "string"
      ? section.text
      : section.text(facts)
    ).trim(),
  }));
const print = ({ section, body }: Printed) =>
  section.title ? `## ${section.title}\n\n${body}` : body;

/** One hash for a prompt's `parts`. */
export const sectionsKey = (parts: Readonly<Record<string, string>>) =>
  hash(JSON.stringify(parts));

export function composeBase(facts: Facts) {
  const sections = bodies(facts);
  /** Section id → a hash of its text, to see later which sections changed. */
  const parts = Object.fromEntries(
    sections.map(({ section, body }) => [section.id, hash(body)]),
  );
  return {
    text: sections.map(print).join("\n\n"),
    parts,
    /** Changes when any section's text does. */
    key: sectionsKey(parts),
  };
}

/** The sections a session started with, kept by a harness that cannot give a
 * running session a new prompt. */
export type StartedSections = Readonly<{
  layout: number;
  parts: Readonly<Record<string, string>>;
}>;
export const startedSections = (
  parts: StartedSections["parts"],
): StartedSections => ({ layout: LAYOUT, parts });

/** The current text of each section that differs from what a session
 * `started` with, for a turn of that session; empty when none does. It is
 * the complete current set each time. A locked section is never in it: a
 * session keeps the locked text it started with. Nor can it name what to
 * replace in a prompt with another layout, or one whose sections were not
 * kept. */
export function sectionUpdates(
  started: StartedSections | undefined,
  facts: Facts,
) {
  if (started?.layout !== LAYOUT || !started.parts) return "";
  const changed = bodies(facts).filter(
    ({ section, body }) =>
      !locked(section) && started.parts[section.id] !== hash(body),
  );
  return changed.length
    ? `<base-section-updates>\nThese sections replace the sections with the same titles in your base instructions. An empty section is off now.\n\n${changed.map(print).join("\n\n")}\n</base-section-updates>`
    : "";
}
