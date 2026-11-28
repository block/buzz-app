/*
 * Vim's modes over plain text, modelled on Neovim's normal.c and ops.c. One
 * key table maps keys to motions, operators, text objects and commands. A
 * motion or a text object gives a range, an operator acts on that range, and
 * counts multiply (`2d3w` deletes six words). `press` is pure: it reads one
 * key and returns the next state and the edits for the editor. The adapter
 * makes each command one undo step. Positions are offsets in the text; in
 * normal mode the cursor is on the character at its offset, as Vim's block
 * cursor is.
 */
export type Mode = "normal" | "insert" | "visual" | "visual-line";
export type Range = Readonly<{ start: number; end: number }>;
/** The unnamed register: what `d`, `c`, `x` and `y` saved, for `p` and `P`. */
export type Register = Readonly<{ text: string; linewise: boolean }>;
export type Vim = Readonly<{
  mode: Mode;
  cursor: number;
  /** Where a visual selection began; the cursor is its moving end. */
  anchor: number;
  /** Keys of a command still being typed, such as `3d`. */
  typed: string;
  /** The column `j` and `k` keep, as Vim's curswant; Infinity after `$`. */
  column?: number | undefined;
}>;
/** The text and its atoms: ranges such as mention chips that move and
 * delete only as a whole. */
export type Buffer = Readonly<{ text: string; atoms: readonly Range[] }>;

const graphemes =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;
/** The buffer with each character longer than one code unit, such as an
 * emoji or a flag, as an atom too, so no key splits one. Offsets stay the
 * editor's own. */
export function withCharacters(buffer: Buffer): Buffer {
  if (!graphemes) return buffer;
  const ranges = [...buffer.atoms];
  for (const { index, segment } of graphemes.segment(buffer.text))
    if (segment.length > 1)
      ranges.push({ start: index, end: index + segment.length });
  if (ranges.length === buffer.atoms.length) return buffer;
  // Overlaps, such as a mark combining with a chip's last letter, become one
  // atom, so atoms never cut into each other.
  const atoms: Range[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const last = atoms.at(-1);
    if (last && range.start < last.end)
      atoms[atoms.length - 1] = {
        start: last.start,
        end: Math.max(last.end, range.end),
      };
    else atoms.push(range);
  }
  return { text: buffer.text, atoms };
}
/** One character on from `at`, an atom as one. */
function characterStep(atoms: readonly Range[], at: number, forward: boolean) {
  const atom = atoms.find((range) =>
    forward ? range.start === at : range.end === at,
  );
  if (atom) return forward ? atom.end : atom.start;
  return forward ? at + 1 : at - 1;
}
export type Edit = Range & Readonly<{ text: string }>;
export type Result = Readonly<{
  vim: Vim;
  /** Replace each range with its text; ranges are in the text before the
   * key and never overlap. The cursor is already where it ends. */
  edits?: readonly Edit[];
  /** Undo or redo this many commands. */
  history?: Readonly<{ redo: boolean; times: number }>;
  register?: Register;
}>;

/** Ctrl-r, as the control character it types. */
export const REDO = "\x12";

export const normal = (cursor = 0): Vim => ({
  mode: "normal",
  cursor,
  anchor: cursor,
  typed: "",
});
export const insert = (cursor: number): Vim => ({
  ...normal(cursor),
  mode: "insert",
});

// Lines.
// `lastIndexOf` reads a negative start as 0, which would find a break at 0.
const lineStart = (text: string, at: number) =>
  at > 0 ? text.lastIndexOf("\n", at - 1) + 1 : 0;
const lineEnd = (text: string, at: number) => {
  const end = text.indexOf("\n", at);
  return end < 0 ? text.length : end;
};
/** The start of each line. */
const lineStarts = (text: string) => {
  const starts = [0];
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1))
    starts.push(at + 1);
  return starts;
};
const lineOf = (text: string, at: number) =>
  lineStarts(text).filter((start) => start <= at).length - 1;
/** The last character of the line, or its start when it is empty. */
const lastChar = (text: string, at: number) =>
  Math.max(lineStart(text, at), lineEnd(text, at) - 1);
const blank = (char: string | undefined) => char === " " || char === "\t";
const firstNonBlank = (text: string, at: number) => {
  const end = lineEnd(text, at);
  let index = lineStart(text, at);
  while (index < end && blank(text[index])) index++;
  return Math.min(index, lastChar(text, at));
};

/** Character classes: blank, keyword and punctuation, as Vim's `w`; a WORD
 * (`W`) is any run of non-blanks. */
const classOf = (char: string | undefined, big = false) =>
  char === undefined || /\s/.test(char)
    ? 0
    : big || /[\p{L}\p{N}_]/u.test(char)
      ? 1
      : 2;
/** An empty line is a word of its own. */
const emptyLine = (text: string, at: number) =>
  text[at] === "\n" && (at === 0 || text[at - 1] === "\n");

function wordForward(text: string, from: number, big: boolean) {
  let at = from;
  const start = classOf(text[at], big);
  if (start) while (at < text.length && classOf(text[at], big) === start) at++;
  else if (text[at] === "\n") at++;
  while (at < text.length && !classOf(text[at]) && !emptyLine(text, at)) at++;
  return at;
}
function wordBackward(text: string, from: number, big: boolean) {
  let at = from - 1;
  while (at > 0 && !classOf(text[at]) && !emptyLine(text, at)) at--;
  if (at <= 0) return 0;
  const start = classOf(text[at], big);
  if (start) while (at > 0 && classOf(text[at - 1], big) === start) at--;
  return at;
}
function wordEnd(text: string, from: number, big: boolean) {
  let at = from + 1;
  while (at < text.length && !classOf(text[at])) at++;
  const start = classOf(text[at], big);
  while (at + 1 < text.length && classOf(text[at + 1], big) === start) at++;
  return Math.min(at, Math.max(0, text.length - 1));
}

/** Where a move lands: never inside an atom, nor past the line's end. */
function land(buffer: Buffer, at: number, forward: boolean, mode: Mode) {
  const { text, atoms } = buffer;
  const inside = (spot: number) =>
    atoms.find((atom) => atom.start < spot && spot < atom.end);
  let spot = Math.max(0, Math.min(at, text.length));
  const atom = inside(spot);
  if (atom) spot = forward ? atom.end : atom.start;
  if (mode !== "insert") spot = Math.min(spot, lastChar(text, spot));
  return inside(spot)?.start ?? spot;
}
/** Grow a range over every atom it cuts into. */
function whole(buffer: Buffer, range: Range): Range {
  let { start, end } = range;
  for (const atom of buffer.atoms)
    if (atom.start < end && start < atom.end) {
      start = Math.min(start, atom.start);
      end = Math.max(end, atom.end);
    }
  return { start, end };
}

// Motions: where the cursor goes, and how an operator takes the range to it.
type Kind = "exclusive" | "inclusive" | "linewise";
type Target = { at: number; kind: Kind; column?: number | undefined };
type MotionArgs = {
  text: string;
  atoms: readonly Range[];
  from: number;
  /** As typed: `G` and `gg` tell no count from 1. */
  count: number | undefined;
  times: number;
  column: number | undefined;
  operator: string | undefined;
};
const repeat = (times: number, from: number, step: (at: number) => number) => {
  let at = from;
  for (let index = 0; index < times; index++) at = step(at);
  return at;
};
function forwardWords(
  { text, from, times, operator }: MotionArgs,
  big: boolean,
): Target {
  // cw changes to the end of the word, not to the next one, as Vim does.
  if (operator === "c" && classOf(text[from]))
    return {
      at: repeat(times, from - 1, (at) => wordEnd(text, at, big)),
      kind: "inclusive",
    };
  let at = from;
  for (let step = 0; step < times; step++) {
    const next = wordForward(text, at, big);
    // An operator on a line's last word stops at the line's end.
    if (
      operator &&
      step === times - 1 &&
      lineOf(text, next) !== lineOf(text, at)
    )
      return { at: Math.max(at, lineEnd(text, at)), kind: "exclusive" };
    at = next;
  }
  return { at, kind: "exclusive" };
}
function verticalLines(
  { text, from, column }: MotionArgs,
  line: number,
  keepColumn: boolean,
): Target {
  const starts = lineStarts(text);
  const target = starts[Math.max(0, Math.min(starts.length - 1, line))] ?? 0;
  if (!keepColumn) return { at: firstNonBlank(text, target), kind: "linewise" };
  const want = column ?? from - lineStart(text, from);
  return {
    at: Math.min(target + want, lastChar(text, target)),
    kind: "linewise",
    column: want,
  };
}
const MOTIONS: Record<string, (args: MotionArgs) => Target> = {
  h: ({ text, atoms, from, times }) => ({
    at: Math.max(
      lineStart(text, from),
      repeat(times, from, (at) => characterStep(atoms, at, false)),
    ),
    kind: "exclusive",
  }),
  l: ({ text, atoms, from, times }) => ({
    at: Math.min(
      lineEnd(text, from),
      repeat(times, from, (at) => characterStep(atoms, at, true)),
    ),
    kind: "exclusive",
  }),
  "0": ({ text, from }) => ({ at: lineStart(text, from), kind: "exclusive" }),
  "^": ({ text, from }) => ({
    at: firstNonBlank(text, from),
    kind: "exclusive",
  }),
  $: ({ text, from, times }) => {
    const starts = lineStarts(text);
    const line = Math.min(lineOf(text, from) + times - 1, starts.length - 1);
    return {
      at: lineEnd(text, starts[line] ?? 0),
      kind: "exclusive",
      column: Number.POSITIVE_INFINITY,
    };
  },
  w: (args) => forwardWords(args, false),
  W: (args) => forwardWords(args, true),
  b: ({ text, from, times }) => ({
    at: repeat(times, from, (at) => wordBackward(text, at, false)),
    kind: "exclusive",
  }),
  B: ({ text, from, times }) => ({
    at: repeat(times, from, (at) => wordBackward(text, at, true)),
    kind: "exclusive",
  }),
  e: ({ text, from, times }) => ({
    at: repeat(times, from, (at) => wordEnd(text, at, false)),
    kind: "inclusive",
  }),
  E: ({ text, from, times }) => ({
    at: repeat(times, from, (at) => wordEnd(text, at, true)),
    kind: "inclusive",
  }),
  j: (args) =>
    verticalLines(args, lineOf(args.text, args.from) + args.times, true),
  k: (args) =>
    verticalLines(args, lineOf(args.text, args.from) - args.times, true),
  gg: (args) => verticalLines(args, (args.count ?? 1) - 1, false),
  G: (args) =>
    verticalLines(
      args,
      (args.count ?? lineStarts(args.text).length) - 1,
      false,
    ),
};

// Text objects: a range around the cursor, after an operator or in visual
// mode, as Neovim's textobject.c.
type ObjectArgs = { text: string; at: number; times: number; around: boolean };
/** `iw` / `aw` (`iW` / `aW`): words, and the blanks around them, in the line. */
function words({ text, at, times, around }: ObjectArgs, big: boolean) {
  const start = lineStart(text, at);
  const end = lineEnd(text, at);
  if (start === end) return undefined;
  const runEnd = (from: number) => {
    const kind = classOf(text[from], big);
    let index = from;
    while (index < end && classOf(text[index], big) === kind) index++;
    return index;
  };
  let from = at;
  const kind = classOf(text[at], big);
  while (from > start && classOf(text[from - 1], big) === kind) from--;
  let to = runEnd(at);
  if (!around) {
    // Each count takes the next run, blank or not.
    for (let step = 1; step < times && to < end; step++) to = runEnd(to);
    return { start: from, end: to };
  }
  // On a blank, `aw` is the blank and the word after it.
  if (!kind) return { start: from, end: to < end ? runEnd(to) : to };
  // Each count takes the blanks and the word after.
  for (let step = 1; step < times && to < end; step++) {
    if (!classOf(text[to])) to = runEnd(to);
    if (to < end) to = runEnd(to);
  }
  // The blanks after the word, or else the ones before it.
  if (to < end && !classOf(text[to])) to = runEnd(to);
  else while (from > start && blank(text[from - 1])) from--;
  return { start: from, end: to };
}
/** `i"` / `a"`: a quoted string in the line, as Vim pairs quotes from the
 * line's start; on none around the cursor, the next one. */
function quoted({ text, at, around }: ObjectArgs, quote: string) {
  const start = lineStart(text, at);
  const end = lineEnd(text, at);
  const marks: number[] = [];
  for (let index = start; index < end; index++)
    if (text[index] === quote && text[index - 1] !== "\\") marks.push(index);
  for (let pair = 0; pair + 1 < marks.length; pair += 2) {
    const open = marks[pair] ?? 0;
    const close = marks[pair + 1] ?? 0;
    if (close < at) continue;
    if (!around) return { start: open + 1, end: close };
    let from = open;
    let to = close + 1;
    if (blank(text[to])) while (blank(text[to])) to++;
    else while (from > start && blank(text[from - 1])) from--;
    return { start: from, end: to };
  }
  return undefined;
}
/** `i(` / `a(` and the other pairs: the `times`th pair around the cursor. */
function bracketed(
  { text, at, times, around }: ObjectArgs,
  open: string,
  close: string,
) {
  let from = text[at] === close ? at - 1 : at;
  let opening = -1;
  for (let level = 0; level < times; level++) {
    let depth = 0;
    for (; from >= 0; from--) {
      if (text[from] === close) depth++;
      else if (text[from] === open && depth-- === 0) break;
    }
    if (from < 0) return undefined;
    opening = from--;
  }
  let depth = 0;
  for (let index = opening + 1; index < text.length; index++) {
    if (text[index] === open) depth++;
    else if (text[index] === close && depth-- === 0)
      return around
        ? { start: opening, end: index + 1 }
        : { start: opening + 1, end: index };
  }
  return undefined;
}
const OBJECTS: Record<string, (args: ObjectArgs) => Range | undefined> = {
  w: (args) => words(args, false),
  W: (args) => words(args, true),
  '"': (args) => quoted(args, '"'),
  "'": (args) => quoted(args, "'"),
  "`": (args) => quoted(args, "`"),
};
for (const [open, close, ...names] of [
  ["(", ")", "b"],
  ["[", "]"],
  ["{", "}", "B"],
  ["<", ">"],
])
  for (const name of [open, close, ...names])
    if (open && close && name)
      OBJECTS[name] = (args) => bracketed(args, open, close);

// Commands. An alias is the keys it stands for, as `:help x` says.
const ALIASES: Record<string, string> = {
  x: "dl",
  X: "dh",
  D: "d$",
  C: "c$",
  s: "cl",
  S: "cc",
  Y: "yy",
};
const OPERATORS = new Set(["d", "c", "y"]);
type Command = (args: {
  vim: Vim;
  buffer: Buffer;
  count: number | undefined;
  register: Register | undefined;
}) => Result;
const COMMANDS: Record<string, Command> = {
  i: ({ vim }) => done(vim, insert(vim.cursor)),
  a: ({ vim, buffer }) => {
    const { text } = buffer;
    const empty = lineStart(text, vim.cursor) === lineEnd(text, vim.cursor);
    return done(
      vim,
      insert(empty ? vim.cursor : land(buffer, vim.cursor + 1, true, "insert")),
    );
  },
  I: ({ vim, buffer: { text } }) => {
    let at = lineStart(text, vim.cursor);
    while (blank(text[at])) at++;
    return done(vim, insert(at));
  },
  A: ({ vim, buffer: { text } }) =>
    done(vim, insert(lineEnd(text, vim.cursor))),
  o: ({ vim, buffer: { text } }) => {
    const end = lineEnd(text, vim.cursor);
    return done(vim, insert(end + 1), {
      edits: [{ start: end, end, text: "\n" }],
    });
  },
  O: ({ vim, buffer: { text } }) => {
    const start = lineStart(text, vim.cursor);
    return done(vim, insert(start), {
      edits: [{ start, end: start, text: "\n" }],
    });
  },
  v: ({ vim }) => done(vim, { mode: "visual", anchor: vim.cursor }),
  V: ({ vim }) => done(vim, { mode: "visual-line", anchor: vim.cursor }),
  u: ({ vim, count }) =>
    done(vim, {}, { history: { redo: false, times: count ?? 1 } }),
  [REDO]: ({ vim, count }) =>
    done(vim, {}, { history: { redo: true, times: count ?? 1 } }),
  p: (args) => put(args, true),
  P: (args) => put(args, false),
  J: ({ vim, buffer: { text }, count }) => join(vim, text, count),
};

const done = (
  vim: Vim,
  next: Partial<Vim>,
  extra: Partial<Result> = {},
): Result => ({ vim: { ...vim, typed: "", ...next }, ...extra });

/** `p` / `P`: put the register after or before the cursor, or its line. */
function put(
  { vim, buffer, count, register }: Parameters<Command>[0],
  after: boolean,
): Result {
  if (!register) return done(vim, {});
  const { text } = buffer;
  const start = lineStart(text, vim.cursor);
  const end = lineEnd(text, vim.cursor);
  const times = count ?? 1;
  if (register.linewise) {
    const body = Array(times).fill(register.text.replace(/\n$/, "")).join("\n");
    const at = after ? end : start;
    const inserted = after ? `\n${body}` : `${body}\n`;
    const next = text.slice(0, at) + inserted + text.slice(at);
    return done(vim, normal(firstNonBlank(next, after ? at + 1 : at)), {
      edits: [{ start: at, end: at, text: inserted }],
    });
  }
  const body = register.text.repeat(times);
  const at = land(
    buffer,
    after && end > start ? vim.cursor + 1 : vim.cursor,
    true,
    "insert",
  );
  return done(vim, normal(Math.max(at, at + body.length - 1)), {
    edits: [{ start: at, end: at, text: body }],
  });
}

/** `J`: join `count` lines (at least two), as Vim does: one space between
 * them, none before a `)` or after a blank. */
function join(vim: Vim, text: string, count: number | undefined): Result {
  const starts = lineStarts(text);
  const first = lineOf(text, vim.cursor);
  const last = Math.min(
    starts.length - 1,
    first + Math.max(1, (count ?? 2) - 1),
  );
  const edits: Edit[] = [];
  let cursor = vim.cursor;
  let removed = 0;
  for (let line = first + 1; line <= last; line++) {
    const start = (starts[line] ?? 0) - 1;
    let end = start + 1;
    while (blank(text[end])) end++;
    const space =
      end === lineEnd(text, end) ||
      text[end] === ")" ||
      blank(text[start - 1]) ||
      start === lineStart(text, start)
        ? ""
        : " ";
    edits.push({ start, end, text: space });
    cursor = start - removed;
    removed += end - start - space.length;
  }
  return done(vim, normal(cursor), edits.length ? { edits } : {});
}

/** The whole lines from `from`'s to `to`'s: their text, as a register, and
 * the range that deletes them with one line break. */
function lines(text: string, from: number, to: number) {
  const start = lineStart(text, Math.min(from, to));
  const end = lineEnd(text, Math.max(from, to));
  return {
    start,
    end,
    register: { text: `${text.slice(start, end)}\n`, linewise: true },
    delete:
      end < text.length
        ? { start, end: end + 1 }
        : { start: Math.max(0, start - 1), end },
  };
}

/** Apply operator `d`, `c` or `y` to a range, or to whole lines. */
function operate(
  vim: Vim,
  buffer: Buffer,
  operator: string,
  target: Range,
  linewise: boolean,
): Result {
  const { text } = buffer;
  if (linewise) {
    const span = lines(text, target.start, target.end);
    if (operator === "y") {
      const cursor =
        lineOf(text, span.start) === lineOf(text, vim.cursor)
          ? vim.cursor
          : firstNonBlank(text, span.start);
      return done(vim, normal(cursor), { register: span.register });
    }
    if (operator === "c") {
      // The lines become one empty line that keeps the first one's indent.
      let indent = span.start;
      while (blank(text[indent])) indent++;
      return done(vim, insert(indent), {
        ...(indent < span.end && {
          edits: [{ start: indent, end: span.end, text: "" }],
        }),
        register: span.register,
      });
    }
    const next = text.slice(0, span.delete.start) + text.slice(span.delete.end);
    return done(
      vim,
      normal(firstNonBlank(next, Math.min(span.delete.start, next.length))),
      { edits: [{ ...span.delete, text: "" }], register: span.register },
    );
  }
  const range = whole(buffer, target);
  const register = {
    text: text.slice(range.start, range.end),
    linewise: false,
  };
  const empty = range.end <= range.start;
  if (operator === "y")
    return done(vim, normal(range.start), empty ? {} : { register });
  const edits = empty ? [] : [{ ...range, text: "" }];
  const extra = empty ? {} : { edits, register };
  if (operator === "c") return done(vim, insert(range.start), extra);
  const next = text.slice(0, range.start) + text.slice(range.end);
  return done(
    vim,
    normal(Math.min(range.start, lastChar(next, range.start))),
    extra,
  );
}

/** Leading digits as a count; a leading `0` is the motion. */
function counted(keys: string) {
  const digits = /^[1-9][0-9]*/.exec(keys)?.[0] ?? "";
  return {
    count: digits ? Number(digits) : undefined,
    rest: keys.slice(digits.length),
  };
}
const multiply = (a?: number, b?: number) =>
  a === undefined && b === undefined ? undefined : (a ?? 1) * (b ?? 1);

/** The entry of `table` that `keys` starts with: the key and what follows
 * it; "pending" when `keys` may still become one. */
function lookup(table: object, keys: string) {
  for (const key of Object.keys(table))
    if (keys.startsWith(key)) return { key, rest: keys.slice(key.length) };
  return Object.keys(table).some((key) => key.startsWith(keys))
    ? ("pending" as const)
    : undefined;
}

/** A motion or a text object after an operator or in visual mode: its range,
 * and whether it takes whole lines. */
function target(
  vim: Vim,
  buffer: Buffer,
  keys: string,
  count: number | undefined,
  operator: string | undefined,
):
  | "pending"
  | { range: Range; linewise: boolean; to: Target | undefined }
  | undefined {
  const { text } = buffer;
  const from = vim.cursor;
  const object =
    /^[ia]/.exec(keys) &&
    (keys.length === 1 ? "pending" : OBJECTS[keys[1] ?? ""]);
  if (object === "pending") return "pending";
  if (object) {
    const range = object({
      text,
      at: from,
      times: count ?? 1,
      around: keys[0] === "a",
    });
    return range && { range, linewise: false, to: undefined };
  }
  const found = lookup(MOTIONS, keys);
  if (found === "pending" || !found) return found;
  const to = MOTIONS[found.key]?.({
    text,
    atoms: buffer.atoms,
    from,
    count,
    times: count ?? 1,
    column: vim.column,
    operator,
  });
  if (!to) return undefined;
  const start = Math.min(from, to.at);
  const end = Math.max(from, to.at) + (to.kind === "inclusive" ? 1 : 0);
  return {
    range: { start, end: Math.min(end, text.length) },
    linewise: to.kind === "linewise",
    to,
  };
}

/** Feed one key to the engine. `register` is the unnamed register. */
export function press(
  vim: Vim,
  buffer: Buffer,
  key: string,
  register?: Register,
): Result {
  if (vim.mode === "insert") {
    if (key !== "Escape") return { vim };
    // Escape steps back over the last character typed, as Vim does.
    const back = Math.max(lineStart(buffer.text, vim.cursor), vim.cursor - 1);
    return done(vim, normal(land(buffer, back, false, "normal")));
  }
  if (key === "Escape") {
    if (vim.mode !== "normal") return done(vim, normal(vim.cursor));
    return { vim: { ...vim, typed: "" } };
  }
  return vim.mode === "normal"
    ? normalKey(vim, buffer, vim.typed + key, register)
    : visualKey(vim, buffer, vim.typed + key);
}

function normalKey(
  vim: Vim,
  buffer: Buffer,
  typed: string,
  register: Register | undefined,
): Result {
  const waiting = { vim: { ...vim, typed } };
  let { count, rest } = counted(typed);
  const alias = ALIASES[rest[0] ?? ""];
  if (alias) rest = alias + rest.slice(1);
  const first = rest[0];
  if (first === undefined) return waiting;

  if (OPERATORS.has(first)) {
    const inner = counted(rest.slice(1));
    const total = multiply(count, inner.count);
    if (!inner.rest) return waiting;
    // dd, cc, yy: `total` whole lines.
    if (inner.rest === first) {
      const last = lineStarts(buffer.text)[
        Math.min(
          lineOf(buffer.text, vim.cursor) + (total ?? 1) - 1,
          lineStarts(buffer.text).length - 1,
        )
      ];
      return operate(
        vim,
        buffer,
        first,
        { start: vim.cursor, end: last ?? vim.cursor },
        true,
      );
    }
    const found = target(vim, buffer, inner.rest, total, first);
    if (found === "pending") return waiting;
    if (!found) return done(vim, {});
    return operate(vim, buffer, first, found.range, found.linewise);
  }

  const motion = lookup(MOTIONS, rest);
  if (motion === "pending") return waiting;
  if (motion) {
    const to = target(vim, buffer, rest, count, undefined);
    if (to && to !== "pending" && to.to)
      return done(vim, {
        cursor: land(buffer, to.to.at, to.to.at > vim.cursor, "normal"),
        column: to.to.column,
      });
  }
  const command = COMMANDS[first];
  // Anything else does nothing, as Vim beeps.
  return command ? command({ vim, buffer, count, register }) : done(vim, {});
}

/** The selection a visual mode shows, and what an operator acts on. */
export function selection(vim: Vim, buffer: Buffer) {
  const from = Math.min(vim.anchor, vim.cursor);
  const to = Math.max(vim.anchor, vim.cursor);
  if (vim.mode === "visual-line") {
    const span = lines(buffer.text, from, to);
    return { start: span.start, end: span.end };
  }
  return whole(buffer, {
    start: from,
    end: Math.min(buffer.text.length, to + 1),
  });
}

function visualKey(vim: Vim, buffer: Buffer, typed: string): Result {
  const { count, rest } = counted(typed);
  const linewise = vim.mode === "visual-line";
  const first = rest[0];
  if (first === undefined) return { vim: { ...vim, typed } };
  const operator = first === "x" ? "d" : first === "s" ? "c" : first;
  if (OPERATORS.has(operator))
    return operate(
      { ...vim, cursor: Math.min(vim.anchor, vim.cursor) },
      buffer,
      operator,
      selection(vim, buffer),
      linewise,
    );
  const found = target(vim, buffer, rest, count, undefined);
  if (found === "pending") return { vim: { ...vim, typed } };
  if (found?.to)
    return done(vim, {
      cursor: land(buffer, found.to.at, found.to.at > vim.cursor, "normal"),
      column: found.to.column,
    });
  if (found) {
    // A text object selects itself, by characters.
    const range = whole(buffer, found.range);
    if (range.end <= range.start) return done(vim, {});
    return done(vim, {
      mode: "visual",
      anchor: range.start,
      cursor: range.end - 1,
    });
  }
  switch (first) {
    case "o":
      return done(vim, { cursor: vim.anchor, anchor: vim.cursor });
    case "v":
    case "V": {
      const mode = first === "v" ? "visual" : "visual-line";
      return done(vim, vim.mode === mode ? normal(vim.cursor) : { mode });
    }
    case "J":
    case "K":
      if (linewise)
        return moveLines(vim, buffer.text, first === "J", count ?? 1);
  }
  return done(vim, {});
}

/** `J` / `K` in visual line mode: move the selected lines down or up past
 * `count` lines, keeping them selected. */
function moveLines(
  vim: Vim,
  text: string,
  down: boolean,
  count: number,
): Result {
  const starts = lineStarts(text);
  const first = lineOf(text, Math.min(vim.anchor, vim.cursor));
  const last = lineOf(text, Math.max(vim.anchor, vim.cursor));
  const steps = Math.min(count, down ? starts.length - 1 - last : first);
  if (steps <= 0) return done(vim, {});
  const lineAt = (line: number) => starts[line] ?? 0;
  const blockStart = lineAt(first);
  const blockEnd = lineEnd(text, lineAt(last));
  const block = text.slice(blockStart, blockEnd);
  if (down) {
    const passedEnd = lineEnd(text, lineAt(last + steps));
    const passed = text.slice(blockEnd + 1, passedEnd);
    const shift = passed.length + 1;
    return done(
      vim,
      { anchor: vim.anchor + shift, cursor: vim.cursor + shift },
      {
        edits: [
          { start: blockStart, end: passedEnd, text: `${passed}\n${block}` },
        ],
      },
    );
  }
  const passedStart = lineAt(first - steps);
  const passed = text.slice(passedStart, blockStart - 1);
  const shift = passed.length + 1;
  return done(
    vim,
    { anchor: vim.anchor - shift, cursor: vim.cursor - shift },
    {
      edits: [
        { start: passedStart, end: blockEnd, text: `${block}\n${passed}` },
      ],
    },
  );
}

/** Keep a cursor read from the editor where the mode allows it. */
export function settle(vim: Vim, buffer: Buffer, cursor = vim.cursor): Vim {
  return { ...vim, cursor: land(buffer, cursor, false, vim.mode) };
}
