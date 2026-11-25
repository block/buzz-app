// Channel naming guidance for the create-channel dialog.
// `blockers` are the hard rules that hold Create back; `tips` are optional hints.

const SUFFIXES = [
  "announce",
  "team",
  "discuss",
  "help",
  "support",
  "questions",
  "commentary",
  "plat",
  "community",
  "alerts",
  "bots",
  "reviews",
  "office",
  "locals",
];
const PREFIXES = ["proj", "prod", "ext", "tmp"];

/** Every accepted type word, for messages that cannot link to the guide. */
export const TYPE_WORDS_HELP = `Suffixes: ${SUFFIXES.map((w) => `-${w}`).join(" ")}. Prefixes: ${PREFIXES.map((w) => `${w}-`).join(" ")}.`;

/** A name's identity for matching: case, spaces, underscores and doubled
 * hyphens don't tell channels apart. */
const similarKey = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

/** An existing channel whose name matches, ignoring case and spacing. */
export function similarChannelName(
  name: string,
  existing: readonly { name: string }[],
): string | undefined {
  const key = similarKey(name);
  if (!key) return undefined;
  return existing.find((channel) => similarKey(channel.name) === key)?.name;
}

export type NameTipInput = {
  name: string;
  temporary: boolean;
  description: string;
};

export type NameTips = {
  /** Friendly, optional suggestions. */
  tips: string[];
  /** Hard rules: Create stays disabled until these are fixed. */
  blockers: string[];
};

export function channelNameTips(input: NameTipInput): NameTips {
  const tips: string[] = [];
  const blockers: string[] = [];
  const name = input.name.trim();
  if (!name) return { tips, blockers };
  // Case and separators don't matter for the type word: "Payments_Team"
  // counts as payments-team. The format rule below still asks for the tidy form.
  const tidy = name
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const parts = tidy.split("-").filter(Boolean);
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  const typed =
    parts.length > 1 && (PREFIXES.includes(first) || SUFFIXES.includes(last));
  const midType = parts.slice(0, -1).some((part) => SUFFIXES.includes(part));

  const bare = parts.length === 1 ? (parts[0] ?? "") : "";
  if (!typed && !(parts.length > 1 && parts.includes("proj"))) {
    if (PREFIXES.includes(bare)) {
      const hint = `Add a topic after ${bare}-, like ${bare}-checkout.`;
      tips.push(hint);
      blockers.push(hint);
    } else if (SUFFIXES.includes(bare)) {
      const hint = `Add a topic before -${bare}, like checkout-${bare}.`;
      tips.push(hint);
      blockers.push(hint);
    } else if (midType) {
      const hint = "Put the type word at the end, like payments-team.";
      tips.push(hint);
      blockers.push(hint);
    } else {
      tips.push(
        "A type word helps people find this: a suffix like -team, -help or -discuss, or a prefix like proj- or tmp-.",
      );
      blockers.push(
        "Add a type word at the end, like checkout-team or checkout-help, or start with proj- or tmp-.",
      );
    }
  }
  if (first !== "proj" && parts.includes("proj")) {
    tips.push("Project channels sort together when proj- comes first.");
    blockers.push("Move proj- to the start, like proj-checkout.");
  }
  // Lowercase letters (any language), numbers and single hyphens between them.
  if (
    name !== name.toLowerCase() ||
    !/^[\p{L}\p{M}\p{N}]+(-[\p{L}\p{M}\p{N}]+)*$/u.test(name)
  ) {
    // Only suggest a name that passes the rules: the tidy form, or with a type
    // word added. Otherwise the hint just states the format.
    const passes = (candidate: string) =>
      !!candidate &&
      channelNameTips({ ...input, name: candidate }).blockers.length === 0;
    const example = [tidy, `${tidy}-team`].find(passes);
    const hint = `Use lowercase letters, numbers and single hyphens${example ? `, like ${example}` : ""}.`;
    tips.push(hint);
    blockers.push(hint);
  }
  const wantsTtl = first === "tmp" || first === "proj";
  if (wantsTtl && !input.temporary) {
    tips.push(
      "A temporary lifetime lets this channel archive itself when it is done.",
    );
  }
  if (!input.description.trim()) {
    tips.push("A short description tells newcomers what this is for.");
  }
  return { tips, blockers };
}
