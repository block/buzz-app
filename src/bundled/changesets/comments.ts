/** A note on a range of lines in one file of a changeset. */
export type LineComment = {
  id: string;
  path: string;
  /** The line it sits under: its number on the side of the diff it is on. */
  at: { side: "additions" | "deletions"; line: number };
  /** Where it points, such as "lines 12-14" or "removed line 3". */
  lines: string;
  /** The covered diff lines, with their +, - or space marker. */
  code: string[];
  text: string;
};

/** Code lines quoted per comment, and characters per line; the agent can
 * read the rest. */
const QUOTED = 6;
const WIDTH = 300;

/** Comments sent from each changeset, kept while Buzz runs so its diff
 * still shows them after closing the panel or switching files. */
export function createComments() {
  const sent = new Map<string, readonly LineComment[]>();
  const listeners = new Set<() => void>();
  let next = 0;
  const NONE: readonly LineComment[] = [];
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    list: (key: string) => sent.get(key) ?? NONE,
    add(key: string, comment: Omit<LineComment, "id">) {
      sent.set(key, [
        ...(sent.get(key) ?? []),
        { ...comment, id: `${next++}` },
      ]);
      for (const listener of listeners) listener();
    },
  };
}
export type Comments = ReturnType<typeof createComments>;

/** Inline code that holds `text` whatever backticks it contains. */
function code(text: string) {
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );
  const ticks = "`".repeat(longest + 1);
  const pad = longest ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

/** The message a comment becomes: where it points, the code it covers and
 * what it says. `folder` names the checkout without its full local path. */
export function formatComment(
  folder: string,
  comment: Omit<LineComment, "id">,
): string {
  const quoted = comment.code
    .slice(0, QUOTED)
    .map((line) => (line.length > WIDTH ? `${line.slice(0, WIDTH)} …` : line));
  if (comment.code.length > QUOTED) quoted.push(" …");
  // A fence longer than any backtick run in the code it quotes.
  const longest = Math.max(
    2,
    ...quoted.flatMap((line) =>
      (line.match(/`+/g) ?? []).map((run) => run.length),
    ),
  );
  const fence = "`".repeat(longest + 1);
  return [
    `Comment on ${code(comment.path)} ${comment.lines}, in ${code(folder)}:`,
    `${fence}diff`,
    ...quoted,
    fence,
    comment.text.trim(),
  ].join("\n");
}
