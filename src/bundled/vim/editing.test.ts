import { expect, test } from "vitest";
import {
  type Mode,
  normal,
  press,
  REDO,
  type Range,
  type Register,
  selection,
  settle,
  type Vim,
  withCharacters,
} from "./editing";

/** Type `keys` in `start`, whose `|` marks the cursor; the text after, with
 * `|` at the cursor, and the mode. `<C-r>` and `<Esc>` are single keys. */
function vim(
  start: string,
  keys: string,
  { atoms = [] as Range[], mode = "normal" as Mode } = {},
) {
  let text = start.replace("|", "");
  let state: Vim = { ...normal(start.indexOf("|")), mode };
  let register: Register | undefined;
  const history: string[] = [];
  for (const key of keys.match(/<C-r>|<Esc>|./gu) ?? []) {
    const result = press(
      state,
      withCharacters({ text, atoms }),
      key === "<Esc>" ? "Escape" : key === "<C-r>" ? REDO : key,
      register,
    );
    for (const edit of [...(result.edits ?? [])].reverse())
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    if (result.history)
      history.push(
        `${result.history.redo ? "redo" : "undo"}×${result.history.times}`,
      );
    register = result.register ?? register;
    // As the message box does after each key, with the text as it is now.
    state = settle(result.vim, withCharacters({ text, atoms }));
  }
  const shown =
    state.mode === "visual" || state.mode === "visual-line"
      ? selection(state, withCharacters({ text, atoms }))
      : undefined;
  return {
    text: `${text.slice(0, state.cursor)}|${text.slice(state.cursor)}`,
    mode: state.mode,
    register: register?.text,
    selected: shown && text.slice(shown.start, shown.end),
    history,
  };
}
const text = (start: string, keys: string) => vim(start, keys).text;

test("motions move by characters, words and lines, with counts", () => {
  expect(text("|hello world", "l")).toBe("h|ello world");
  expect(text("|hello world", "5l")).toBe("hello| world");
  expect(text("|hello world", "20l")).toBe("hello worl|d");
  expect(text("hel|lo", "h")).toBe("he|llo");
  expect(text("hel|lo", "9h")).toBe("|hello");
  expect(text("hel|lo", "0")).toBe("|hello");
  expect(text("  |hi there", "$")).toBe("  hi ther|e");
  expect(text("|a\nbc\nde", "2$")).toBe("a\nb|c\nde");
  expect(text("  hi th|ere", "^")).toBe("  |hi there");
  expect(text("|one two, three", "w")).toBe("one |two, three");
  expect(text("|one two, three", "2w")).toBe("one two|, three");
  expect(text("one two, |three", "b")).toBe("one two|, three");
  expect(text("one two, |three", "2b")).toBe("one |two, three");
  expect(text("|one two", "e")).toBe("on|e two");
  expect(text("|one two", "2e")).toBe("one tw|o");
  // WORDs are runs of non-blanks.
  expect(text("|a.b c.d", "W")).toBe("a.b |c.d");
  expect(text("a.b c.|d", "B")).toBe("a.b |c.d");
  expect(text("|a.b c.d", "E")).toBe("a.|b c.d");
  // Down and up keep the column; short lines clamp it.
  expect(text("ab|cd\nx\nefgh", "j")).toBe("abcd\n|x\nefgh");
  expect(text("ab|cd\nx\nefgh", "2j")).toBe("abcd\nx\nef|gh");
  expect(text("abcd\nx\nef|gh", "2k")).toBe("ab|cd\nx\nefgh");
  expect(text("a|b\ncdef", "$k")).toBe("a|b\ncdef");
  expect(text("a\n  b\n|c", "gg")).toBe("|a\n  b\nc");
  expect(text("|a\n  b\nc", "G")).toBe("a\n  b\n|c");
  expect(text("|a\n  b\nc", "2G")).toBe("a\n  |b\nc");
  expect(text("a\n  b\n|c", "2gg")).toBe("a\n  |b\nc");
  // An empty first line is a line like any other.
  expect(text("|\nab", "j")).toBe("\n|ab");
  expect(text("\na|b", "k")).toBe("|\nab");
  expect(text("|\nab", "dd")).toBe("|ab");
  // w crosses lines and stops on an empty one.
  expect(text("|ab\n\ncd", "w")).toBe("ab\n|\ncd");
});

test("d, c and y act on a motion, with counts on either side", () => {
  expect(vim("|one two three", "dw")).toMatchObject({
    text: "|two three",
    register: "one ",
  });
  expect(text("|one two three four", "d2w")).toBe("|three four");
  expect(text("|one two three four", "3dw")).toBe("|four");
  expect(text("|a b c d e f g", "2d3w")).toBe("|g");
  // dw on a line's last word keeps the line break.
  expect(text("one |two\nthree", "dw")).toBe("one| \nthree");
  expect(text("one |two three", "d$")).toBe("one| ");
  expect(text("one |two three", "de")).toBe("one | three");
  expect(text("one two |three", "db")).toBe("one |three");
  expect(text("one |two", "d0")).toBe("|two");
  expect(text("|abc", "dl")).toBe("|bc");
  expect(text("a\n|b\nc", "dj")).toBe("|a");
  expect(text("a\nb\n|c", "dk")).toBe("|a");
  expect(text("a\n|b\nc", "dG")).toBe("|a");
  expect(text("a\n|b\nc", "dgg")).toBe("|c");
  // An unknown target cancels the operator.
  expect(vim("|one two", "dqw")).toMatchObject({ text: "one |two" });
  expect(text("|one two", "d<Esc>w")).toBe("one |two");
  // c deletes and types; cw stops at the word's end, as Vim's does.
  expect(vim("|one two", "cw")).toMatchObject({
    text: "| two",
    mode: "insert",
    register: "one",
  });
  expect(text("|one two three", "c2w")).toBe("| three");
  expect(text("one |two", "c$")).toBe("one |");
  expect(text("one |two", "cb")).toBe("|two");
  expect(vim("one |two", "yw")).toMatchObject({
    text: "one |two",
    register: "two",
  });
  expect(vim("one |two", "yb")).toMatchObject({
    text: "|one two",
    register: "one ",
  });
  expect(vim("o|ne two", "y$")).toMatchObject({ register: "ne two" });
});

test("dd, cc and yy act on whole lines, and the shorthands are operators", () => {
  expect(vim("a\n|b\nc\nd", "dd")).toMatchObject({
    text: "a\n|c\nd",
    register: "b\n",
  });
  expect(text("a\n|b\nc\nd", "3dd")).toBe("|a");
  expect(text("a\nb\n|c", "dd")).toBe("a\n|b");
  expect(text("|  a\nb", "dd")).toBe("|b");
  expect(vim("a\n  |b c\nd", "cc")).toMatchObject({
    text: "a\n  |\nd",
    mode: "insert",
    register: "  b c\n",
  });
  expect(text("a\n|b\nc\nd", "2cc")).toBe("a\n|\nd");
  expect(vim("a\nb|c", "yy")).toMatchObject({
    text: "a\nb|c",
    register: "bc\n",
  });
  expect(vim("|a\nb\nc", "2yy")).toMatchObject({ register: "a\nb\n" });
  expect(vim("|abcdef", "3x")).toMatchObject({ text: "|def", register: "abc" });
  expect(text("ab|c", "x")).toBe("a|b");
  expect(text("ab|c", "X")).toBe("a|c");
  expect(text("one |two three", "D")).toBe("one| ");
  expect(vim("one |two", "C")).toMatchObject({
    text: "one |",
    mode: "insert",
  });
  expect(vim("|abc", "s")).toMatchObject({ text: "|bc", mode: "insert" });
  expect(vim("a\n|bc\nd", "S")).toMatchObject({
    text: "a\n|\nd",
    mode: "insert",
  });
  expect(vim("a|b\nc", "Y")).toMatchObject({ register: "ab\n" });
});

test("iw and aw select words, and the blanks around them", () => {
  expect(vim("one t|wo three", "diw")).toMatchObject({
    text: "one | three",
    register: "two",
  });
  expect(vim("one t|wo three", "daw")).toMatchObject({
    text: "one |three",
    register: "two ",
  });
  // With no blank after, aw takes the one before.
  expect(text("one t|wo", "daw")).toBe("on|e");
  expect(text("on|e  two", "diw")).toBe("|  two");
  // On blanks, iw is the blanks and aw adds the word after.
  expect(text("one | two", "diw")).toBe("one|two");
  expect(text("one | two x", "daw")).toBe("one| x");
  expect(text("f|oo.bar", "diw")).toBe("|.bar");
  expect(text("f|oo.bar baz", "diW")).toBe("| baz");
  expect(text("f|oo.bar baz", "daW")).toBe("|baz");
  // Counts take more words; iw counts the blanks between.
  expect(text("|one two three", "d2aw")).toBe("|three");
  expect(text("|one two three", "d3iw")).toBe("| three");
  expect(vim("one t|wo three", "ciw")).toMatchObject({
    text: "one | three",
    mode: "insert",
  });
  expect(vim("one t|wo three", "yiw")).toMatchObject({
    text: "one |two three",
    register: "two",
  });
  // Words stay on their line; an empty line has none.
  expect(text("ab\nc|d\nef", "diw")).toBe("ab\n|\nef");
  expect(text("a\n|\nb", "diw")).toBe("a\n|\nb");
});

test("quote and bracket objects select inside or around a pair", () => {
  expect(text('say "h|ello there" now', 'di"')).toBe('say "|" now');
  expect(text('say "h|ello" now', 'da"')).toBe("say |now");
  expect(text("say 'h|i'", "di'")).toBe("say '|'");
  expect(text("run `l|s` now", "ci`")).toBe("run `|` now");
  // Before a pair on the line, the next pair.
  expect(text('|x = "a b"', 'di"')).toBe('x = "|"');
  expect(text("f(a, (|b))", "di(")).toBe("f(a, (|))");
  expect(text("f(a, (|b))", "d2i(")).toBe("f(|)");
  expect(text("f(a, (|b))", "da)")).toBe("f(a, |)");
  expect(text("f(a, (b|))", "dib")).toBe("f(a, (|))");
  expect(text("x [a |b] y", "di[")).toBe("x [|] y");
  expect(text("x {\n  |a\n} y", "diB")).toBe("x {|} y");
  expect(text("x <a|b> y", "da<")).toBe("x | y");
  // Nothing around the cursor: nothing happens.
  expect(text("a|b", "di(")).toBe("a|b");
  // c on an empty pair types inside it.
  expect(vim("f(|)", "ci(")).toMatchObject({ text: "f(|)", mode: "insert" });
});

test("p and P put the register after and before, by character or line", () => {
  expect(text("|one two", "dwP")).toBe("one| two");
  expect(text("|ab", "xp")).toBe("b|a");
  expect(text("|a\nb", "yyp")).toBe("a\n|a\nb");
  expect(text("|a\nb", "yyjP")).toBe("a\n|a\nb");
  expect(text("|a\nb", "dd2p")).toBe("b\n|a\na");
  expect(text("|a", "p")).toBe("|a");
});

test("J joins lines with one space", () => {
  expect(text("o|ne\n   two", "J")).toBe("one| two");
  expect(text("|a\nb\nc\nd", "3J")).toBe("a b| c\nd");
  expect(text("|a \nb", "J")).toBe("a |b");
  expect(text("|f(\n)", "J")).toBe("f(|)");
  expect(text("|a\n\nb", "J")).toBe("|a\nb");
  expect(text("|\nb", "J")).toBe("|b");
  expect(text("a\n|b", "J")).toBe("a\n|b");
});

test("i, a, I, A, o and O enter insert mode where Vim does", () => {
  expect(vim("ab|c", "i")).toMatchObject({ text: "ab|c", mode: "insert" });
  expect(text("ab|c", "a")).toBe("abc|");
  expect(text("a\n|\nb", "a")).toBe("a\n|\nb");
  expect(text("  a|bc", "I")).toBe("  |abc");
  expect(text("a|bc\nd", "A")).toBe("abc|\nd");
  expect(text("a|bc\nd", "o")).toBe("abc\n|\nd");
  expect(text("abc\n|d", "O")).toBe("abc\n|\nd");
  // Escape leaves insert mode one character back, as Vim does.
  expect(vim("abc|", "<Esc>", { mode: "insert" })).toMatchObject({
    text: "ab|c",
    mode: "normal",
  });
  expect(text("a\n|b", "<Esc>")).toBe("a\n|b");
});

test("u and Ctrl-r undo and redo commands, with counts", () => {
  expect(vim("|a", "u").history).toEqual(["undo×1"]);
  expect(vim("|a", "3u<C-r>").history).toEqual(["undo×3", "redo×1"]);
  expect(vim("|a\nb", "yypu<C-r>")).toMatchObject({
    history: ["undo×1", "redo×1"],
    mode: "normal",
  });
});

test("visual modes select, extend, take text objects and operate", () => {
  expect(vim("|one two", "vw")).toMatchObject({
    mode: "visual",
    selected: "one t",
  });
  expect(vim("|one two", "vwd")).toMatchObject({
    text: "|wo",
    mode: "normal",
    register: "one t",
  });
  expect(text("one |two", "vhhx")).toBe("on|wo");
  expect(vim("|one two", "vey")).toMatchObject({
    text: "|one two",
    register: "one",
  });
  expect(vim("one t|wo", "vc")).toMatchObject({
    text: "one t|o",
    mode: "insert",
  });
  expect(vim("one t|wo three", "viw")).toMatchObject({
    selected: "two",
    mode: "visual",
  });
  expect(vim("one t|wo three", "vaw")).toMatchObject({ selected: "two " });
  expect(vim("f(a |b)", "vi(")).toMatchObject({ selected: "a b" });
  expect(text("a|b cd", "viwd")).toBe("| cd");
  expect(vim("a\n|b\nc", "Vj")).toMatchObject({
    mode: "visual-line",
    selected: "b\nc",
  });
  expect(text("a\n|b\nc", "Vjd")).toBe("|a");
  expect(vim("a\n|b\nc", "Vy")).toMatchObject({ register: "b\n" });
  expect(vim("a\n|b\nc", "Vc")).toMatchObject({
    text: "a\n|\nc",
    mode: "insert",
  });
  expect(vim("|ab", "vlo")).toMatchObject({ text: "|ab", selected: "ab" });
  expect(vim("a|b", "v<Esc>").mode).toBe("normal");
  expect(vim("a|b", "vV").mode).toBe("visual-line");
  expect(vim("a|b", "Vv").mode).toBe("visual");
  expect(vim("a|b", "VV").mode).toBe("normal");
});

test("J and K in visual line mode move the lines and keep them selected", () => {
  expect(vim("|a\nb\nc", "VJ")).toMatchObject({
    text: "b\n|a\nc",
    mode: "visual-line",
    selected: "a",
  });
  expect(vim("|a\nb\nc\nd", "VjJ")).toMatchObject({
    text: "c\na\n|b\nd",
    selected: "a\nb",
  });
  expect(vim("a\nb\n|c", "VK")).toMatchObject({
    text: "a\n|c\nb",
    selected: "c",
  });
  expect(text("a\nb\n|c", "V2K")).toBe("|c\na\nb");
  // At the edge they stay put.
  expect(text("a\n|b", "VJ")).toBe("a\n|b");
  expect(text("|a\nb", "VK")).toBe("|a\nb");
});

test("an atom such as a mention chip moves and deletes as a whole", () => {
  const atoms = [{ start: 3, end: 9 }];
  expect(vim("hi |@alice ok", "l", { atoms }).text).toBe("hi @alice| ok");
  expect(vim("hi @alice| ok", "h", { atoms }).text).toBe("hi |@alice ok");
  expect(vim("hi |@alice ok", "x", { atoms }).text).toBe("hi | ok");
  expect(vim("h|i @alice ok", "d3l", { atoms }).text).toBe("h| ok");
  expect(vim("hi @al|ice ok", "diw", { atoms }).text).toBe("hi | ok");
});

test("an emoji, a flag or a family is one character to move over, delete and select", () => {
  expect(vim("|😀a", "x").text).toBe("|a");
  expect(vim("|😀a", "l").text).toBe("😀|a");
  expect(vim("a😀|b", "h").text).toBe("a|😀b");
  expect(vim("|🇺🇸 ok", "dl").text).toBe("| ok");
  expect(vim("a|👨‍👩‍👧b", "vd").text).toBe("a|b");
  expect(vim("|😀😀", "lx").text).toBe("|😀");
  // Counts count characters, not the editor's code units.
  expect(vim("|😀ab", "2l").text).toBe("😀a|b");
  expect(vim("ab|😀", "2h").text).toBe("|ab😀");
  expect(vim("|😀ab", "2x").text).toBe("|b");
  // A mark that combines with a chip's last letter stays with the chip.
  const atoms = [{ start: 0, end: 2 }];
  expect(vim("ab\u0301|c", "X", { atoms }).text).toBe("|c");
  expect(withCharacters({ text: "ab\u0301c", atoms }).atoms).toEqual([
    { start: 0, end: 3 },
  ]);
});
