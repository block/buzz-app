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

/** An existing channel whose name matches, ignoring case and spacing. */
export function similarChannelName(
  name: string,
  existing: readonly { name: string }[],
): string | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  return existing.find((channel) => channel.name.trim().toLowerCase() === key)
    ?.name;
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
  // Case and separators don't matter: "Payments_Team" counts as payments-team.
  const parts = name
    .toLowerCase()
    .split(/[-_\s]+/)
    .filter(Boolean);
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  const typed =
    parts.length > 1 && (PREFIXES.includes(first) || SUFFIXES.includes(last));
  const midType = parts.slice(0, -1).some((part) => SUFFIXES.includes(part));

  if (!typed && !parts.includes("proj")) {
    if (midType) {
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
