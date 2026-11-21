/*
 * Multi-key sequences such as `gg`, `]b` and `<leader>sk`. The first key is a
 * registered shortcut (listed and rebindable in Settings → Shortcuts); the
 * keys after it are read here while the sequence is pending. Keys are spelled
 * as typed, with the leader as " ".
 */
export type Sequence = Readonly<{ keys: string; title: string; run(): void }>;
/** A named prefix, shown while it is pending: `<leader>s` is "Search". */
export type SequenceGroup = Readonly<{ keys: string; title: string }>;
export type SequenceChoice = Readonly<{
  key: string;
  title: string;
  group: boolean;
}>;

export const LEADER = " ";

/** What can follow `typed`, one row per next key, in table order. */
export function sequenceChoices(
  typed: string,
  sequences: readonly Sequence[],
  groups: readonly SequenceGroup[],
): SequenceChoice[] {
  const choices = new Map<string, SequenceChoice>();
  for (const { keys, title } of sequences) {
    if (keys.length <= typed.length || !keys.startsWith(typed)) continue;
    const key = keys.charAt(typed.length);
    if (choices.has(key)) continue;
    const group = keys.length > typed.length + 1;
    choices.set(key, {
      key,
      group,
      title: group
        ? (groups.find((entry) => entry.keys === typed + key)?.title ?? title)
        : title,
    });
  }
  return [...choices.values()];
}

export type SequenceStep =
  | Readonly<{ kind: "run"; sequence: Sequence }>
  | Readonly<{ kind: "more" }>
  | Readonly<{ kind: "none" }>;

export function sequenceStep(
  typed: string,
  sequences: readonly Sequence[],
): SequenceStep {
  const sequence = sequences.find(({ keys }) => keys === typed);
  if (sequence) return { kind: "run", sequence };
  return sequences.some(({ keys }) => keys.startsWith(typed))
    ? { kind: "more" }
    : { kind: "none" };
}

/** How a key reads in the which-key menu and Settings. */
export const keyLabel = (key: string) => (key === LEADER ? "Space" : key);
