// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { afterEach, expect, it } from "vitest";
import { fromMarkdown } from "mdast-util-from-markdown";
import { EditableInput } from "./EditableInput";
import type { ComposerInputElement } from "./composer-dom";
import { composerDOMFixture } from "./composer-testing";
import { composerMarkdown } from "./composer-markdown";
import { mentionDraft, type MentionDraft } from "./mention-draft";

composerDOMFixture();
afterEach(cleanup);

function mount(text = "") {
  const ref = createRef<ComposerInputElement>();
  let draft: MentionDraft = mentionDraft(text);
  function Editor() {
    const [value, setValue] = useState(draft);
    return (
      <EditableInput
        ref={ref}
        draft={value}
        value={value.text}
        disabled={false}
        placeholder="Draft"
        maxLength={16000}
        decorationsFor={() => []}
        onFormatsChange={() => {}}
        onDraftChange={(next) => {
          draft = next;
          setValue(next);
        }}
      />
    );
  }
  render(<Editor />, { reactStrictMode: true });
  const input = ref.current;
  if (!input) throw new Error("Editor did not mount");
  act(() => {
    input.focus();
    input.setSelectionRange(text.length, text.length);
  });
  return {
    input,
    user: userEvent.setup(),
    markdown: () => composerMarkdown(draft),
    draft: () => draft,
  };
}

/** Exercise ProseMirror's actual MutationObserver/readDOMChange seam, including
 * marksAcross on deletion. This is not a claim about native WebKit keystrokes. */
async function deleteCodeTail(input: ComposerInputElement, count = 1) {
  const previous = input.value;
  act(() => {
    input.focus();
    fireEvent(
      input,
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "deleteContentBackward",
      }),
    );
    const text = input.querySelector("code")?.firstChild;
    if (!(text instanceof Text)) throw new Error("Code text did not mount");
    const selection = document.getSelection();
    if (!selection) throw new Error("DOM selection unavailable");
    const end = text.length - count;
    if (end) {
      text.deleteData(end, count);
      selection.collapse(text, end);
    } else {
      const paragraph = input.querySelector("p");
      if (!paragraph) throw new Error("Paragraph did not mount");
      paragraph.replaceChildren(document.createElement("br"));
      selection.collapse(paragraph, 0);
    }
  });
  await waitFor(() => expect(input).toHaveValue(previous.slice(0, -count)));
}

it("keeps explicit code mode through DOM deletions, but clears it after the last character", async () => {
  const h = mount();
  act(() => h.input.toggleFormat("code"));
  await h.user.keyboard("abc");
  await deleteCodeTail(h.input);
  await h.user.keyboard("d");
  expect(h.markdown()).toBe("`abd`");
  await deleteCodeTail(h.input);
  expect(h.markdown()).toBe("`ab`");
  act(() => h.input.undo(false));
  expect(h.markdown()).toBe("`abd`");
  act(() => h.input.undo(true));
  expect(h.markdown()).toBe("`ab`");
  await deleteCodeTail(h.input, 2);
  await h.user.keyboard("plain");
  expect(h.markdown()).toBe("plain");
});

it.each(["typed", "explicit-off"])(
  "does not reenable code after deletion in %s mode",
  async (mode) => {
    const h = mount();
    if (mode === "typed") await h.user.keyboard("`abc`");
    else {
      act(() => h.input.toggleFormat("code"));
      await h.user.keyboard("abc");
      act(() => h.input.toggleFormat("code"));
    }
    await deleteCodeTail(h.input);
    await h.user.keyboard("d");
    expect(h.markdown()).toBe("`ab`d");
  },
);

it("does not borrow backticks inside existing rich code for a newly typed span", async () => {
  const h = mount("`");
  act(() => {
    h.input.setSelectionRange(0, 1);
    h.input.toggleFormat("code");
    h.input.setSelectionRange(1, 1);
  });
  await h.user.keyboard(" `next`!");
  expect(h.input.querySelectorAll("code")).toHaveLength(2);
  expect(h.input.querySelectorAll("code")[1]).toHaveTextContent("next");
  expect(h.input).toHaveValue("` next!");
  expect(h.markdown()).toBe("`` ` `` `next`!");
});

it("clearing all code and reentering a code edge leaves subsequent prose unmarked", async () => {
  const h = mount();
  act(() => h.input.toggleFormat("code"));
  await h.user.keyboard("abc");
  act(() => h.input.setSelectionRange(3, 3));
  await h.user.keyboard("plain");
  expect(h.markdown()).toBe("`abc`plain");
  act(() => {
    h.input.setSelectionRange(0, h.input.value.length);
    h.input.insertText("");
  });
  await h.user.keyboard("outside");
  expect(h.markdown()).toBe("outside");
});

it("converts typed **Hello** on the closing delimiter, keeps later typing plain and undoes in one step", async () => {
  const h = mount();
  await h.user.keyboard("**Hello**");
  expect(h.input.querySelector("strong")).toHaveTextContent("Hello");
  expect(h.input).toHaveValue("Hello");
  expect(h.markdown()).toBe("**Hello**");
  await h.user.keyboard(" world");
  expect(h.input.querySelector("strong")).toHaveTextContent("Hello");
  expect(h.markdown()).toBe("**Hello** world");
  // The prose typed next is its own step; one more undo restores the source.
  act(() => h.input.undo(false));
  expect(h.markdown()).toBe("**Hello**");
  act(() => h.input.undo(false));
  expect(h.input.querySelector("strong")).toBeNull();
  expect(h.input).toHaveValue("**Hello**");
  act(() => h.input.undo(true));
  expect(h.input.querySelector("strong")).toHaveTextContent("Hello");
  const saved = JSON.parse(JSON.stringify(h.draft()));
  act(() => h.input.reset(saved));
  expect(h.input.querySelector("strong")).toHaveTextContent("Hello");
  expect(h.markdown()).toBe("**Hello**");
});

it("one undo after a typed code span restores the closing backtick too", async () => {
  const h = mount();
  await h.user.keyboard("`abc`");
  expect(h.markdown()).toBe("`abc`");
  act(() => h.input.undo(false));
  expect(h.input.querySelector("code")).toBeNull();
  expect(h.input).toHaveValue("`abc`");
});

it.each([
  ["__x__", "strong", "**x**"],
  ["*x*", "em", "_x_"],
  ["_x_", "em", "_x_"],
  ["~~x~~", "s", "~~x~~"],
])(
  "converts typed %s and sends the serializer's canonical delimiters",
  async (typed, tag, wire) => {
    const h = mount();
    await h.user.keyboard(typed);
    expect(h.input.querySelector(tag)).toHaveTextContent("x");
    expect(h.input).toHaveValue("x");
    expect(h.markdown()).toBe(wire);
  },
);

it("adds both marks for ***x*** and leaves ~x~ literal", async () => {
  const h = mount();
  await h.user.keyboard("***x***");
  expect(h.input.querySelector("em strong, strong em")).toHaveTextContent("x");
  expect(h.input).toHaveValue("x");
  expect(h.markdown()).toBe("**_x_**");
  await h.user.keyboard(" ~y~");
  expect(h.input.querySelector("s")).toBeNull();
  expect(h.input).toHaveValue("x ~y~");
  expect(h.markdown()).toBe("**_x_** ~y~");
});

it("waits for the whole closing run instead of italicising midway through **a**", async () => {
  const h = mount();
  await h.user.keyboard("**a*");
  expect(h.input.querySelector("em, strong")).toBeNull();
  expect(h.input).toHaveValue("**a*");
  await h.user.keyboard("*");
  expect(h.input.querySelector("strong")).toHaveTextContent("a");
  expect(h.input.querySelector("em")).toBeNull();
  expect(h.markdown()).toBe("**a**");
});

it("follows the parser for intraword delimiters: snake_case stays literal, 5*3*2 italicises 3", async () => {
  const h = mount();
  await h.user.keyboard("snake_case_more 5*3*2");
  expect(h.input.querySelectorAll("em")).toHaveLength(1);
  expect(h.input.querySelector("em")).toHaveTextContent("3");
  expect(h.input).toHaveValue("snake_case_more 532");
  // The wire form encodes the neighbours so recipients render what the composer shows.
  expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
    type: "paragraph",
    children: [
      { type: "text", value: "snake_case_more 5" },
      { type: "emphasis", children: [{ type: "text", value: "3" }] },
      { type: "text", value: "2" },
    ],
  });
});

it("leaves delimiters typed inside inline code or a code block literal", async () => {
  const h = mount();
  act(() => h.input.toggleFormat("code"));
  await h.user.keyboard("**x**");
  act(() => h.input.toggleFormat("code"));
  expect(h.input.querySelector("strong")).toBeNull();
  expect(h.input.querySelector("code")).toHaveTextContent("**x**");
  expect(h.markdown()).toBe("`**x**`");
  const block = mount();
  act(() => block.input.toggleFormat("code_block"));
  await block.user.keyboard("_y_ ~~z~~");
  expect(block.input.querySelector("em, s")).toBeNull();
  expect(block.markdown()).toBe("```\n_y_ ~~z~~\n```");
});

it.each([true, false])(
  "leaves delimiters around a link label (linked=%s) and pasted delimiters literal",
  async (linked) => {
    const h = mount("**label");
    act(() => {
      h.input.setSelectionRange(2, 7);
      const edit = h.input.editLink();
      if (!edit) throw new Error("Link editing unavailable");
      if (linked) edit.save("label", "https://example.com");
      else edit.remove();
      h.input.setSelectionRange(7, 7);
    });
    await h.user.keyboard("**");
    expect(h.input.querySelector("strong")).toBeNull();
    expect(h.input).toHaveValue("**label**");
    expect(h.markdown()).toBe(
      linked ? "**[label](https://example.com/)**" : "**label**",
    );
    act(() => {
      h.input.setSelectionRange(0, h.input.value.length);
      h.input.insertText("**pasted** _source_");
    });
    expect(h.input.querySelector("strong, em")).toBeNull();
    expect(h.markdown()).toBe("**pasted** _source_");
  },
);

it("bolds a mention typed between delimiters and keeps its chip and recipient", async () => {
  const h = mount();
  const honey = { pubkey: "a".repeat(64), name: "Honey" };
  await h.user.keyboard("**");
  act(() => h.input.insertText("", honey));
  expect(h.input).toHaveValue("**@Honey ");
  act(() => h.input.setSelectionRange(8, 8));
  await h.user.keyboard("**");
  expect(h.input).toHaveValue("@Honey ");
  expect(h.input.querySelector('strong [data-source="@Honey"]')).not.toBeNull();
  expect(h.draft().recipients).toEqual([{ ...honey, start: 0, end: 6 }]);
  expect(h.markdown()).toBe("**@Honey** ");
});

it.each([
  ["bullet_list", "ul", "-"],
  ["ordered_list", "ol", "1."],
] as const)(
  "edits %s through continuation, indent/outdent, exit, undo and persistence",
  async (format, tag, marker) => {
    const h = mount("one\ntwo");
    act(() => {
      h.input.setSelectionRange(0, 7);
      h.input.toggleFormat(format);
    });
    expect(h.input.querySelectorAll(`${tag} > li`)).toHaveLength(2);
    act(() => h.input.setSelectionRange(7, 7));
    await h.user.keyboard("{Shift>}{Enter}{/Shift}three");
    expect(h.input.querySelectorAll(`${tag} > li`)).toHaveLength(3);
    await h.user.keyboard("{Tab}");
    expect(h.input.querySelector(`${tag} ${tag}`)).not.toBeNull();
    await h.user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(h.input.querySelector(`${tag} ${tag}`)).toBeNull();
    await h.user.keyboard("{Shift>}{Enter}{Enter}{/Shift}outside");
    expect(h.input.querySelector(":scope > p")).toHaveTextContent("outside");
    const wire =
      marker === "-"
        ? "- one\n- two\n- three\n\noutside"
        : "1. one\n2. two\n3. three\n\noutside";
    expect(h.markdown()).toBe(wire);
    const saved = JSON.parse(JSON.stringify(h.draft()));
    act(() => h.input.reset(saved));
    expect(h.input.querySelectorAll(`${tag} > li`)).toHaveLength(3);
    expect(h.markdown()).toBe(wire);
  },
);

it("switches an existing list in place, including a nested list's first item", async () => {
  const h = mount("one\ntwo\nthree");
  act(() => {
    h.input.setSelectionRange(0, 13);
    h.input.toggleFormat("bullet_list");
    h.input.setSelectionRange(7, 7);
  });
  await h.user.keyboard("{Tab}");
  expect(h.input.querySelector("ul ul")).not.toBeNull();
  act(() => h.input.toggleFormat("ordered_list"));
  expect(h.input.querySelector("ul > li > ol > li")).toHaveTextContent("two");
  expect(h.input.querySelectorAll(":scope > ul > li")).toHaveLength(2);
  act(() => h.input.undo(false));
  expect(h.input.querySelector("ul ul")).not.toBeNull();
  act(() => h.input.undo(true));
  expect(h.input.querySelector("ul > li > ol > li")).toHaveTextContent("two");
});

it.each(["blockquote", "code_block"] as const)(
  "exits %s and clears its structure with select-all deletion",
  async (format) => {
    const h = mount("one");
    act(() => h.input.toggleFormat(format));
    await h.user.keyboard(
      "{Shift>}{Enter}{/Shift}two{Shift>}{Enter}{Enter}{/Shift}outside",
    );
    expect(h.input.querySelector(":scope > p")).toHaveTextContent("outside");
    expect(h.markdown()).toBe(
      format === "blockquote"
        ? "> one\n> two\n\noutside"
        : "```\none\ntwo\n```\n\noutside",
    );
    await h.user.keyboard("{Control>}a{/Control}{Backspace}");
    expect(h.input).toHaveValue("");
    expect(h.input.querySelector("pre, blockquote")).toBeNull();
    await h.user.keyboard("plain");
    expect(h.markdown()).toBe("plain");
  },
);

it("opens a code block from a typed fence on Shift+Enter, with one undo restoring the source", async () => {
  const h = mount();
  await h.user.keyboard("```{Shift>}{Enter}{/Shift}");
  expect(h.input.querySelector("pre > code")).not.toBeNull();
  expect(h.input).toHaveValue("");
  act(() => h.input.undo(false));
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input).toHaveValue("```");
  act(() => h.input.undo(true));
  expect(h.input.querySelector("pre > code")).not.toBeNull();
  await h.user.keyboard("code{Shift>}{Enter}{/Shift}more");
  expect(h.input).toHaveValue("code\nmore");
  expect(h.markdown()).toBe("```\ncode\nmore\n```");
  // The typed text is its own undo step; it never merges into the conversion.
  act(() => h.input.undo(false));
  expect(h.input.querySelector("pre > code")).not.toBeNull();
  expect(h.input).not.toHaveValue("```");
  act(() => h.input.undo(true));
  await h.user.keyboard("{Shift>}{Enter}{Enter}{/Shift}outside");
  expect(h.input.querySelector(":scope > p")).toHaveTextContent("outside");
  expect(h.markdown()).toBe("```\ncode\nmore\n```\n\noutside");
  const saved = JSON.parse(JSON.stringify(h.draft()));
  act(() => h.input.reset(saved));
  expect(h.input.querySelectorAll("pre > code")).toHaveLength(1);
  expect(h.markdown()).toBe("```\ncode\nmore\n```\n\noutside");
});

it.each([
  ["```ts", "ts", "```ts\nx\n```"],
  ["~~~", null, "```\nx\n```"],
  ["````c++", "c++", "```c++\nx\n```"],
])(
  "keeps the info string of %s as the block language through send and persistence",
  async (fence, language, wire) => {
    const h = mount();
    await h.user.keyboard(`${fence}{Shift>}{Enter}{/Shift}x`);
    const pre = h.input.querySelector("pre");
    if (!pre) throw new Error("Fence did not open a code block");
    if (language) expect(pre).toHaveAttribute("data-language", language);
    else expect(pre).not.toHaveAttribute("data-language");
    expect(h.input).toHaveValue("x");
    expect(h.markdown()).toBe(wire);
    const saved = JSON.parse(JSON.stringify(h.draft()));
    act(() => h.input.reset(saved));
    expect(h.markdown()).toBe(wire);
  },
);

it("opens a fence typed after existing prose as a separate block", async () => {
  const h = mount("intro");
  await h.user.keyboard("{Shift>}{Enter}{/Shift}```{Shift>}{Enter}{/Shift}x");
  expect(h.input.querySelector(":scope > p")).toHaveTextContent("intro");
  expect(h.input.querySelector(":scope > pre > code")).toHaveTextContent("x");
  expect(h.input).toHaveValue("intro\nx");
  expect(h.markdown()).toBe("intro\n\n```\nx\n```");
});

it.each(["a```", "``", "``` ", "```a b", "```:smile:"])(
  "leaves %s followed by Shift+Enter as paragraph text",
  async (line) => {
    const h = mount();
    await h.user.keyboard(`${line}{Shift>}{Enter}{/Shift}x`);
    expect(h.input.querySelector("pre")).toBeNull();
    expect(h.input).toHaveValue(`${line}\nx`);
    expect(h.markdown()).toBe(`${line}\nx`);
  },
);

it("keeps a fence typed inside an existing code block literal", async () => {
  const h = mount();
  act(() => h.input.toggleFormat("code_block"));
  await h.user.keyboard("```{Shift>}{Enter}{/Shift}x");
  expect(h.input.querySelectorAll("pre")).toHaveLength(1);
  expect(h.input).toHaveValue("```\nx");
  expect(h.markdown()).toBe("````\n```\nx\n````");
});

it("does not convert a fence carrying inline code or pasted source", async () => {
  const h = mount();
  act(() => h.input.toggleFormat("code"));
  await h.user.keyboard("```");
  act(() => h.input.toggleFormat("code"));
  await h.user.keyboard("{Shift>}{Enter}{/Shift}x");
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input.querySelector("code")).toHaveTextContent("```");
  act(() => {
    h.input.setSelectionRange(0, h.input.value.length);
    h.input.insertText("```\ncode\n```");
  });
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.markdown()).toBe("```\ncode\n```");
});

it("switches a nested bullet to its ordered ancestor's type without outdenting", async () => {
  const h = mount("one\ntwo\nthree");
  act(() => {
    h.input.setSelectionRange(0, 13);
    h.input.toggleFormat("ordered_list");
    h.input.setSelectionRange(7, 7);
  });
  await h.user.keyboard("{Tab}");
  act(() => h.input.toggleFormat("bullet_list"));
  expect(h.input.querySelector("ol ul")).not.toBeNull();
  act(() => h.input.toggleFormat("ordered_list"));
  expect(h.input.querySelector("ol ol > li")).toHaveTextContent("two");
  expect(h.input.querySelectorAll(":scope > ol > li")).toHaveLength(2);
});

it.each([true, false])(
  "continues a list with explicit Bold=%s typing mode",
  async (enabled) => {
    const h = mount("one");
    act(() => {
      h.input.setSelectionRange(0, 3);
      h.input.toggleFormat("bold");
      h.input.toggleFormat("bullet_list");
      h.input.setSelectionRange(3, 3);
      if (!enabled) h.input.toggleFormat("bold");
    });
    await h.user.keyboard("{Shift>}{Enter}{/Shift}two");
    const item = h.input.querySelectorAll("li")[1];
    if (!item) throw new Error("List did not split");
    expect(!!item.querySelector("strong")).toBe(enabled);
  },
);

it("retains the native caret after replacing text with an unchanged suffix", async () => {
  const h = mount(":unknown:");
  act(() => {
    const text = h.input.querySelector("p")?.firstChild;
    if (!(text instanceof Text)) throw new Error("Missing native text node");
    text.data = ":nosource:";
    document.getSelection()?.collapse(text, text.length);
  });
  await waitFor(() => expect(h.input).toHaveValue(":nosource:"));
  expect(h.input.selectionStart).toBe(10);
  expect(h.input.selectionEnd).toBe(10);
});
