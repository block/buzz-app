// Marked Bestie instruction sections. Settings and owner-data authorization
// share this policy so a damaged section cannot be off in one and on in the other.
type Feature = Readonly<{ id: string; version: number; text: string }>;

const ESCAPE = /[.*+?^${}()|[\]\\]/g;
const nameOf = ({ id }: Pick<Feature, "id">) =>
  `buzz:bestie/${id}`.replace(ESCAPE, "\\$&");
/** Each of the feature's sections, in any version: an opening and a closing
 * marker with no other opening between them. Text before the opening or
 * after the closing, even on the marker's line, is the owner's. */
const sections = (feature: Pick<Feature, "id">) => {
  const name = nameOf(feature);
  const open = `<!-- ${name} v\\d+ -->`;
  return new RegExp(`${open}(?:(?!${open})[\\s\\S])*?<!-- /${name} -->`, "g");
};
/** What is left of a marker once its whole sections are taken out: the
 * feature's name, with what is left around it of a marker's comment and
 * version. Groups: the comment's opening, and the slash of a closing. */
const leftovers = (feature: Pick<Feature, "id">) =>
  new RegExp(
    `(<!--[ \\t]*)?(/)?[ \\t]*${nameOf(feature)}(?![\\w.]|-\\w)(?:[ \\t]*v\\d+)?(?:[ \\t]*-->)?`,
    "g",
  );

/** Whether `instructions` hold the feature's section: `on` for one or more
 * whole sections, `edited` when a marker of it was changed, removed or added
 * by hand, so where it starts or ends is the owner's to say. */
export function featureState(
  instructions: string,
  feature: Pick<Feature, "id">,
): "on" | "off" | "edited" {
  const rest = instructions.replace(sections(feature), "");
  if (leftovers(feature).test(rest)) return "edited";
  return rest === instructions ? "off" : "on";
}

/** Whether `instructions` hold the feature's section, whole. */
export function hasFeature(instructions: string, feature: Pick<Feature, "id">) {
  return featureState(instructions, feature) === "on";
}

const block = ({ id, version, text }: Feature) =>
  `<!-- buzz:bestie/${id} v${version} -->\n${text}\n<!-- /buzz:bestie/${id} -->`;

/** `instructions` with the feature's section added at the end, or with each
 * of its whole sections removed along with the blank lines that set it
 * apart. The rest is left as it is, down to the owner's line ending after
 * their text. On adds nothing while any part of a section is there. */
export function withFeature(
  instructions: string,
  feature: Feature,
  on: boolean,
) {
  if (on) {
    if (featureState(instructions, feature) !== "off") return instructions;
    const kept = instructions.replace(/\r?\n\s*$/, "");
    // What followed the owner's text now follows the section.
    const after = instructions.slice(kept.length);
    return kept.trim()
      ? `${kept}\n\n${block(feature)}${after}`
      : `${block(feature)}\n`;
  }
  const parts = instructions.split(sections(feature));
  if (parts.length === 1) return instructions;
  const last = parts.at(-1) ?? "";
  const kept = parts
    .map((part, index) => {
      let kept = part;
      // Text on a marker's line keeps its own line.
      if (index > 0)
        kept = /^\s*\n/.test(kept)
          ? kept.replace(/^\s*\n/, "")
          : kept.replace(/^[ \t]+/, "");
      if (index < parts.length - 1)
        kept = kept.replace(/\r?\n\s*$/, "").replace(/[ \t]+$/, "");
      return kept;
    })
    .filter((part) => part.trim())
    .join("\n\n");
  // A section at the end gives back the line ending that came after it.
  return kept && !last.trim() ? `${kept}${last}` : kept;
}

/** `instructions` with an edited section put back as the feature adds it,
 * along with any whole copies of it, or undefined unless what is left of its
 * markers shows where it starts and ends: two comments, an opening then a
 * closing, with no other Bestie section's marker between them. Only the
 * markers and what lies between them are replaced. */
export function restoredFeature(instructions: string, feature: Feature) {
  const rest = withFeature(instructions, feature, false);
  const found = [...rest.matchAll(leftovers(feature))];
  const [first, last] = found;
  if (
    found.length !== 2 ||
    !first?.[1] ||
    first[2] ||
    !last?.[1] ||
    !last[2] ||
    rest
      .slice(first.index + first[0].length, last.index)
      .includes("buzz:bestie/")
  )
    return undefined;
  const end = last.index + last[0].length;
  return `${rest.slice(0, first.index)}${block(feature)}${rest.slice(end)}`;
}
