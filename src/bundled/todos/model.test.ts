import { describe, expect, it } from "vitest";
import { addTodo, readTodos, toggleTodo } from "./model";

describe("Canvas todo source edits", () => {
  it("changes only the selected checkbox byte, including duplicate labels and CRLF", () => {
    const content =
      "# Notes\r\nuntouched  \r\n\r\n## Todos\r\n\r\n- [ ] Same\r\n- [X] Same\r\n\r\n## Keep\r\n- [ ] Not a todo\r\n";
    const { items } = readTodos(content);
    expect(items.map((i) => [i.label, i.checked])).toEqual([
      ["Same", false],
      ["Same", true],
    ]);
    const item = items[1];
    if (!item) throw new Error("Expected second todo");
    const changed = toggleTodo(content, item.offset, false);
    expect(changed).toBe(content.replace("[X]", "[ ]"));
    expect(toggleTodo(changed, item.offset, true)).toBe(
      content.replace("[X]", "[x]"),
    );
  });
  it("recognizes actual Markdown structure, not examples or nested task lists", () => {
    const content =
      "```md\n## Todos\n- [ ] Fenced\n```\n\n## Todos\n\n- [ ] Real\n  - [ ] Nested\n\n    [ ] Continuation\n\n> - [ ] Quoted\n\n```\n- [ ] Code\n```\n\n### Details\n\n+ [x] Also real\n\n# Next\n\n- [ ] Other\n";
    expect(readTodos(content).items.map((i) => i.label)).toEqual([
      "Real",
      "Also real",
    ]);
  });
  it("preserves prose, sections, markers and trailing whitespace when adding", () => {
    const before =
      "Preamble  \r\n\r\n## Todos ###\r\n\r\nNotes  \r\n* [x] Old\r\n\r\n## Other\r\nKeep exactly.  ";
    const next = addTodo(before, " New **task** ");
    expect(next).toBe(
      before.replace(
        "## Todos ###",
        "## Todos ###\r\n\r\n- [ ] New **task**\r\n",
      ),
    );
    expect(readTodos(next).items.map((i) => i.label)).toEqual([
      "New **task**",
      "Old",
    ]);
  });
  it.each(["", "# Notes\nKeep me.", "# Notes\r\nKeep me."])(
    "creates one ordinary Todos section without rewriting existing content (%j)",
    (content) => {
      const next = addTodo(content, "First");
      expect(next.startsWith(content)).toBe(true);
      expect(readTodos(next).items.map((i) => i.label)).toEqual(["First"]);
      expect(
        readTodos(addTodo(next, "Second")).items.map((i) => i.label),
      ).toEqual(["Second", "First"]);
    },
  );
  it("rejects ambiguous headings, multiline entries, stale offsets and swallowed insertions", () => {
    expect(() => readTodos("## Todos\n\n## Todos\n")).toThrow(/more than one/);
    expect(() => addTodo("", "a\n## Escape")).toThrow(/single line/);
    expect(() => addTodo("", "   ")).toThrow(/single line/);
    expect(() => toggleTodo("## Todos\n- [ ] Hi", 0, true)).toThrow(/changed/);
    expect(() => addTodo("```unterminated\n", "Oops")).toThrow(/safely/);
    expect(() => addTodo("<!-- open comment\n", "Oops")).toThrow(/safely/);
  });
});
