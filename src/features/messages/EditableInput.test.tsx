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
import { EditableInput } from "./EditableInput";
import type { ComposerInputElement } from "./composer-dom";
import { composerDOMFixture } from "./composer-testing";
import { composerMarkdown } from "./composer-markdown";
import { mentionDraft, type MentionDraft } from "./mention-draft";

composerDOMFixture();
afterEach(cleanup);

function mount(initial: string | MentionDraft = "") {
  const ref = createRef<ComposerInputElement>();
  let draft: MentionDraft = mentionDraft(initial);
  const text = draft.text;
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
        // Explicit recipients render as mention tokens, as in RichComposerInput.
        decorationsFor={(current) =>
          current.recipients.map(({ start, end, name }) => ({
            start,
            end,
            content: <span data-mention>@{name}</span>,
          }))
        }
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

const imp = { pubkey: "a".repeat(64), name: "Imp" };
const jitter = { pubkey: "b".repeat(64), name: "Jitter" };
/** Every `@Imp`/`@Jitter` in the text is an explicit, resolved recipient. */
function mentioned(text: string): MentionDraft {
  return {
    text,
    recipients: [imp, jitter].flatMap((recipient) => {
      const start = text.indexOf(`@${recipient.name}`);
      return start < 0
        ? []
        : [{ ...recipient, start, end: start + recipient.name.length + 1 }];
    }),
  };
}
const selection = (input: ComposerInputElement) =>
  [input.selectionStart, input.selectionEnd, input.selectionDirection] as const;
/** Arrow keys are deliberately low-level: user-event cannot extend a selection. */
const shiftArrow = (
  input: ComposerInputElement,
  key: "ArrowLeft" | "ArrowRight",
) =>
  act(() => {
    fireEvent.keyDown(input, { key: "Shift", keyCode: 16, shiftKey: true });
    fireEvent.keyDown(input, {
      key,
      code: key,
      keyCode: key === "ArrowLeft" ? 37 : 39,
      shiftKey: true,
    });
  });

it("extends a backward selection over the mention before it and keeps the anchor", () => {
  const text = "@Imp say hello to @Jitter ";
  const h = mount(mentioned(text));
  expect(h.input.querySelectorAll("[data-mention]")).toHaveLength(2);
  act(() => h.input.setSelectionRange(text.length, text.length));
  // The browser itself answers the first Shift+Left by selecting the trailing
  // space. Model that native result, then let the editor handle the second.
  act(() => {
    const space = h.input.querySelector("p")?.lastChild;
    if (!(space instanceof Text)) throw new Error("Missing trailing text");
    document.getSelection()?.setBaseAndExtent(space, 1, space, 0);
  });
  shiftArrow(h.input, "ArrowLeft");
  expect(selection(h.input)).toEqual([18, 26, "backward"]);
  expect(text.slice(18, 26)).toBe("@Jitter ");
  shiftArrow(h.input, "ArrowRight");
  expect(selection(h.input)).toEqual([25, 26, "backward"]);
});

it.each([
  [
    "after a mention with no trailing space",
    "@Imp say hello to @Jitter",
    25,
    "ArrowLeft",
    [18, 25, "backward"],
  ],
  [
    "before a mention",
    "@Imp say hello to @Jitter ",
    18,
    "ArrowRight",
    [18, 25, "forward"],
  ],
  [
    "after the mention at the start",
    "@Imp say hello to @Jitter ",
    4,
    "ArrowLeft",
    [0, 4, "backward"],
  ],
  [
    "the document start",
    "@Imp say hello to @Jitter ",
    0,
    "ArrowRight",
    [0, 4, "forward"],
  ],
  ["the document end", "hello @Jitter", 13, "ArrowLeft", [6, 13, "backward"]],
] as const)(
  "Shift+Arrow from %s selects the whole mention",
  (_, text, caret, key, expected) => {
    const h = mount(mentioned(text));
    act(() => h.input.setSelectionRange(caret, caret));
    shiftArrow(h.input, key);
    expect(selection(h.input)).toEqual(expected);
  },
);

it.each([
  [
    "extends a forward selection from prose over a mention",
    16,
    18,
    "forward",
    "ArrowRight",
    [16, 25, "forward"],
  ],
  [
    "extends a backward selection from prose over a mention",
    4,
    8,
    "backward",
    "ArrowLeft",
    [0, 8, "backward"],
  ],
  [
    "shrinks a forward selection off a mention",
    18,
    25,
    "forward",
    "ArrowLeft",
    [18, 18, "forward"],
  ],
  [
    "shrinks a backward selection off a mention",
    18,
    26,
    "backward",
    "ArrowRight",
    [25, 26, "backward"],
  ],
] as const)("%s", (_, start, end, direction, key, expected) => {
  const h = mount(mentioned("@Imp say hello to @Jitter "));
  act(() => h.input.setSelectionRange(start, end, direction));
  expect(selection(h.input)).toEqual([start, end, direction]);
  shiftArrow(h.input, key);
  expect(selection(h.input)).toEqual(expected);
});

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
