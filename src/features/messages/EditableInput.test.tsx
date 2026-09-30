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
import { afterEach, expect, it, vi } from "vitest";
import { fromMarkdown } from "mdast-util-from-markdown";
import { MessageMarkdown } from "./MessageMarkdown";
import { EditableInput } from "./EditableInput";
import type { ComposerFormat, ComposerInputElement } from "./composer-dom";
import { composerDOMFixture } from "./composer-testing";
import { composerMarkdown } from "./composer-markdown";
import { mentionDraft, type MentionDraft } from "./mention-draft";
import { profileMentionParts } from "./profile-mentions";
import { profileTarget } from "../profiles/target";

composerDOMFixture();
afterEach(cleanup);

/** The editor's text/plain paste handler, not the insertText API. */
function paste(input: ComposerInputElement, text: string) {
  act(() => {
    input.focus();
    fireEvent.paste(input, {
      clipboardData: {
        items: [],
        getData: (type: string) => (type === "text/plain" ? text : ""),
      },
    });
  });
}

function mount(initial: string | MentionDraft = "") {
  const ref = createRef<ComposerInputElement>();
  let draft: MentionDraft = mentionDraft(initial);
  let formats: readonly ComposerFormat[] = [];
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
        decorationsFor={() => []}
        onFormatsChange={(active) => {
          formats = active;
        }}
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
    /** The formats last reported to the toolbar. */
    formats: () => formats,
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

it("waits for the whole closing run instead of italicising midway through **a** or ***b***", async () => {
  const h = mount();
  await h.user.keyboard("**a*");
  expect(h.input.querySelector("em, strong")).toBeNull();
  expect(h.input).toHaveValue("**a*");
  await h.user.keyboard("*");
  expect(h.input.querySelector("strong")).toHaveTextContent("a");
  expect(h.input.querySelector("em")).toBeNull();
  expect(h.markdown()).toBe("**a**");
  // A run touching the span's opener is unfinished whichever of its
  // characters sits beside the span.
  await h.user.keyboard(" ***b*");
  expect(h.input).toHaveValue("a ***b*");
  expect(h.input.querySelector("em")).toBeNull();
  await h.user.keyboard("*");
  expect(h.input).toHaveValue("a ***b**");
  expect(h.input.querySelectorAll("strong")).toHaveLength(1);
  await h.user.keyboard("*");
  expect(h.input).toHaveValue("a b");
  expect(h.markdown()).toBe("**a** **_b_**");
});

it.each([
  ["snake_case _x_", "snake_case ", "x"],
  ["file_name and _important_", "file_name and ", "important"],
  ["5 * 3 is *great*", "5 * 3 is ", "great"],
])(
  "converts %s: an earlier literal delimiter blocks only a span it touches",
  async (typed, before, inner) => {
    const h = mount();
    await h.user.keyboard(typed);
    expect(h.input.querySelectorAll("em")).toHaveLength(1);
    expect(h.input.querySelector("em")).toHaveTextContent(inner);
    expect(h.input).toHaveValue(before + inner);
    expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: before },
        { type: "emphasis", children: [{ type: "text", value: inner }] },
      ],
    });
  },
);

it("follows the parser for intraword delimiters: snake_case stays literal, 5*3*2 italicises 3", async () => {
  const h = mount();
  await h.user.keyboard("snake_case_more 5*3*2");
  expect(h.input.querySelectorAll("em")).toHaveLength(1);
  expect(h.input.querySelector("em")).toHaveTextContent("3");
  expect(h.input).toHaveValue("snake_case_more 532");
  // The wire keeps the typed asterisks, which form intraword where _ would
  // need its neighbours encoded, so raw readers see the source as typed.
  expect(h.markdown()).toBe("snake_case_more 5*3*2");
  expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
    type: "paragraph",
    children: [
      { type: "text", value: "snake_case_more 5" },
      { type: "emphasis", children: [{ type: "text", value: "3" }] },
      { type: "text", value: "2" },
    ],
  });
});

it.each(["a*b**", "a*b**c"])(
  "preserves displayed emphasis when sending %s",
  async (typed) => {
    const h = mount();
    await h.user.keyboard(typed);
    expect(h.input.querySelector("em")).toHaveTextContent("b");
    expect(h.markdown()).toBe(`a*b*\\${typed.slice(4)}`);
    expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: "a" },
        { type: "emphasis", children: [{ type: "text", value: "b" }] },
        { type: "text", value: typed.slice(4) },
      ],
    });
  },
);

it("preserves toolbar italics after a typed literal asterisk", async () => {
  const h = mount();
  await h.user.keyboard("5*");
  act(() => h.input.toggleFormat("italic"));
  await h.user.keyboard("x");
  act(() => h.input.toggleFormat("italic"));
  await h.user.keyboard("y");
  expect(h.input.querySelector("em")).toHaveTextContent("x");
  expect(h.markdown()).toBe("5\\**x*y");
  expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
    type: "paragraph",
    children: [
      { type: "text", value: "5*" },
      { type: "emphasis", children: [{ type: "text", value: "x" }] },
      { type: "text", value: "y" },
    ],
  });
});

/** Render the actual send payload, including signed recipients, through the timeline. */
function renderDraft(draft: MentionDraft) {
  const open = vi.fn(() => true);
  const view = render(
    <MessageMarkdown
      row={{
        id: "sent",
        channelId: "channel",
        authorId: "author",
        createdAt: 1,
        content: composerMarkdown(draft),
        mentions: draft.recipients.map(({ pubkey }) => pubkey),
        participants: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
      }}
      participantProfiles={
        new Map(draft.recipients.map(({ pubkey, name }) => [pubkey, { name }]))
      }
      media={() => undefined}
      onOpenLink={open}
      canOpenLink={() => true}
    />,
  );
  return { ...view, open };
}

it.each([
  ["paste", "**Note**", "strong"],
  ["restore", "**Note**", "strong"],
  ["paste", "*Note*", "em"],
  ["restore", "*Note*", "em"],
])(
  "preserves %s authored %s on both sides of generated italics",
  async (mode, source, tag) => {
    const h = mount(mode === "restore" ? source : "");
    if (mode === "paste") paste(h.input, source);
    act(() => h.input.toggleFormat("italic"));
    await h.user.keyboard("x");
    expect(h.markdown()).toBe(`${source}_x_`);
    act(() => h.input.toggleFormat("italic"));
    await h.user.keyboard("y");
    const after = renderDraft(h.draft());
    expect(after.container.querySelector(tag)).toHaveTextContent("Note");
    expect(after.container.querySelector("em:last-child")).toHaveTextContent(
      "x",
    );
    expect(after.container).toHaveTextContent("Notexy");
    after.unmount();
    act(() => {
      h.input.reset(mentionDraft(mode === "restore" ? source : ""));
    });
    if (mode === "paste") paste(h.input, source);
    act(() => h.input.setSelectionRange(0, 0));
    await h.user.keyboard("a");
    act(() => h.input.toggleFormat("italic"));
    await h.user.keyboard("x");
    const before = renderDraft(h.draft());
    expect(
      before.container.querySelector(`${tag}:last-child`),
    ).toHaveTextContent("Note");
    expect(before.container.querySelector("em")).toHaveTextContent("x");
    expect(before.container).toHaveTextContent("axNote");
  },
);

it.each([
  [false, "c "],
  [true, "c "],
  [false, " "],
  [true, " "],
])(
  "preserves star-suffixed recipient identity beside italic punctuation (prefix collision=%s, suffix=%s)",
  async (collision, suffix) => {
    const h = mount();
    const starred = { pubkey: "a".repeat(64), name: "Honey*" };
    const shorter = { pubkey: "b".repeat(64), name: "Honey" };
    act(() => {
      h.input.insertText("", starred);
      h.input.setSelectionRange(7, 8);
      h.input.insertText("");
      h.input.toggleFormat("italic");
    });
    await h.user.keyboard("!");
    act(() => h.input.toggleFormat("italic"));
    await h.user.keyboard(suffix);
    if (collision) act(() => h.input.insertText("", shorter));
    expect(h.draft().recipients.map(({ pubkey }) => pubkey)).toEqual(
      collision ? [starred.pubkey, shorter.pubkey] : [starred.pubkey],
    );
    const sent = renderDraft(h.draft());
    const starButton = sent.getByRole("button", {
      name: "View Honey* profile",
    });
    fireEvent.click(starButton);
    expect(sent.open).toHaveBeenLastCalledWith(profileTarget(starred.pubkey));
    if (collision) {
      fireEvent.click(sent.getByRole("button", { name: "View Honey profile" }));
      expect(sent.open).toHaveBeenLastCalledWith(profileTarget(shorter.pubkey));
    }
    expect(sent.container.querySelectorAll("button")).toHaveLength(
      collision ? 2 : 1,
    );
    expect(sent.container.querySelector("em")).toHaveTextContent("!");
    expect(sent.container).toHaveTextContent(
      `Honey*!${suffix}${collision ? "Honey" : ""}`.trim(),
    );
  },
);

it("keeps source offsets when a raw span has both a leading star and a star-suffixed recipient", async () => {
  const h = mount();
  const starred = { pubkey: "a".repeat(64), name: "Honey*" };
  const shorter = { pubkey: "b".repeat(64), name: "Honey" };
  await h.user.keyboard("a*b** see ");
  act(() => {
    h.input.insertText("", starred);
    h.input.setSelectionRange(h.input.value.length - 1, h.input.value.length);
    h.input.insertText("");
    h.input.toggleFormat("italic");
  });
  await h.user.keyboard("!");
  act(() => h.input.toggleFormat("italic"));
  await h.user.keyboard("c ");
  act(() => h.input.insertText("", shorter));
  const sent = renderDraft(h.draft());
  fireEvent.click(sent.getByRole("button", { name: "View Honey* profile" }));
  expect(sent.open).toHaveBeenLastCalledWith(profileTarget(starred.pubkey));
  fireEvent.click(sent.getByRole("button", { name: "View Honey profile" }));
  expect(sent.open).toHaveBeenLastCalledWith(profileTarget(shorter.pubkey));
  expect(
    [...sent.container.querySelectorAll("em")].map((el) => el.textContent),
  ).toEqual(["b", "!"]);
  expect(sent.container).toHaveTextContent("ab* see Honey*!c Honey");
});

it("preserves italic punctuation immediately before a signed mention", async () => {
  const h = mount("a");
  const honey = { pubkey: "a".repeat(64), name: "Honey" };
  act(() => h.input.toggleFormat("italic"));
  await h.user.keyboard("!");
  act(() => {
    h.input.toggleFormat("italic");
    h.input.insertText("", honey);
  });
  const sent = renderDraft(h.draft());
  expect(sent.container.querySelector("em")).toHaveTextContent("!");
  fireEvent.click(sent.getByRole("button", { name: "View Honey profile" }));
  expect(sent.open).toHaveBeenLastCalledWith(profileTarget(honey.pubkey));
  expect(sent.container).toHaveTextContent("a!Honey");
});

it("converts a span typed on a heading line, which the timeline renders as a heading", async () => {
  const h = mount();
  await h.user.keyboard("# Title **bold**");
  expect(h.input.querySelector("strong")).toHaveTextContent("bold");
  expect(h.input).toHaveValue("# Title bold");
  expect(h.markdown()).toBe("# Title **bold**");
  expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
    type: "heading",
    depth: 1,
    children: [
      { type: "text", value: "Title " },
      { type: "strong", children: [{ type: "text", value: "bold" }] },
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

it("italicises a mention typed between asterisks and sends a form the timeline still binds", async () => {
  const h = mount();
  const honey = { pubkey: "a".repeat(64), name: "Honey" };
  await h.user.keyboard("*");
  act(() => h.input.insertText("", honey));
  expect(h.input).toHaveValue("*@Honey ");
  act(() => h.input.setSelectionRange(7, 7));
  await h.user.keyboard("*");
  expect(h.input).toHaveValue("@Honey ");
  expect(h.input.querySelector('em [data-source="@Honey"]')).not.toBeNull();
  expect(h.draft().recipients).toEqual([{ ...honey, start: 0, end: 6 }]);
  // _@Honey_ would render italic but never bind: _ is a name character.
  expect(h.markdown()).toBe("*@Honey* ");
  expect(
    profileMentionParts(
      { content: h.markdown(), mentions: [honey.pubkey] },
      new Map([[honey.pubkey, { name: honey.name }]]),
    ),
  ).toEqual([
    { text: "*" },
    { text: "@Honey", target: profileTarget(honey.pubkey) },
    { text: "* " },
  ]);
});

it("keeps an italic mention bound after a literal asterisk", async () => {
  const h = mount();
  const honey = { pubkey: "a".repeat(64), name: "Honey" };
  await h.user.keyboard("a*");
  act(() => {
    h.input.insertText("", honey);
    h.input.setSelectionRange(2, 8);
    h.input.toggleFormat("italic");
  });
  expect(h.input.querySelector('em [data-source="@Honey"]')).not.toBeNull();
  expect(h.draft().recipients).toEqual([{ ...honey, start: 2, end: 8 }]);
  expect(h.markdown()).toBe("a\\**@Honey* ");
  expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
    type: "paragraph",
    children: [
      { type: "text", value: "a*" },
      { type: "emphasis", children: [{ type: "text", value: "@Honey" }] },
    ],
  });
  expect(
    profileMentionParts(
      { content: h.markdown(), mentions: [honey.pubkey] },
      new Map([[honey.pubkey, { name: honey.name }]]),
    ),
  ).toEqual([
    { text: "a\\**" },
    { text: "@Honey", target: profileTarget(honey.pubkey) },
    { text: "* " },
  ]);
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

it("opens a code block as the third backtick is typed, with one undo restoring the source", async () => {
  const h = mount();
  await h.user.keyboard("``");
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input).toHaveValue("``");
  await h.user.keyboard("`");
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

it("keeps the line literal after undoing the conversion, including a fourth backtick", async () => {
  const h = mount();
  await h.user.keyboard("```");
  expect(h.input.querySelector("pre")).not.toBeNull();
  act(() => h.input.undo(false));
  await h.user.keyboard("`");
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input).toHaveValue("````");
  await h.user.keyboard("{Shift>}{Enter}{/Shift}x");
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input).toHaveValue("````\nx");
  expect(h.markdown()).toBe("````\nx");
});

it("opens a code block from a typed ~~~ line and sends it fenced", async () => {
  const h = mount();
  await h.user.keyboard("~~~x");
  const pre = h.input.querySelector("pre");
  if (!pre) throw new Error("Fence did not open a code block");
  expect(pre).not.toHaveAttribute("data-language");
  expect(pre.querySelector("code")).toHaveTextContent("x");
  expect(h.input).toHaveValue("x");
  expect(h.markdown()).toBe("```\nx\n```");
  const saved = JSON.parse(JSON.stringify(h.draft()));
  act(() => h.input.reset(saved));
  expect(h.markdown()).toBe("```\nx\n```");
});

it("keeps a restored block language through send and persistence", () => {
  const h = mount({
    text: "x",
    recipients: [],
    document: {
      version: 1,
      content: {
        type: "doc",
        content: [
          {
            type: "code_block",
            attrs: { language: "ts" },
            content: [{ type: "text", text: "x" }],
          },
        ],
      },
    },
  });
  expect(h.input.querySelector("pre")).toHaveAttribute("data-language", "ts");
  expect(h.markdown()).toBe("```ts\nx\n```");
  const saved = JSON.parse(JSON.stringify(h.draft()));
  act(() => h.input.reset(saved));
  expect(h.input.querySelector("pre")).toHaveAttribute("data-language", "ts");
  expect(h.markdown()).toBe("```ts\nx\n```");
});

it("opens a fence typed after existing prose as a separate block", async () => {
  const h = mount("intro");
  await h.user.keyboard("{Shift>}{Enter}{/Shift}```x");
  expect(h.input.querySelector(":scope > p")).toHaveTextContent("intro");
  expect(h.input.querySelector(":scope > pre > code")).toHaveTextContent("x");
  expect(h.input).toHaveValue("intro\nx");
  expect(h.markdown()).toBe("intro\n\n```\nx\n```");
});

it("opens a block between prose lines when the fence is typed on an empty middle line", async () => {
  const h = mount("intro\n\noutro");
  act(() => h.input.setSelectionRange(6, 6));
  await h.user.keyboard("```x");
  const paragraphs = h.input.querySelectorAll(":scope > p");
  expect(paragraphs).toHaveLength(2);
  expect(paragraphs[0]).toHaveTextContent("intro");
  expect(paragraphs[1]).toHaveTextContent("outro");
  expect(h.input.querySelector(":scope > pre > code")).toHaveTextContent("x");
  expect(h.input).toHaveValue("intro\nx\noutro");
  expect(h.markdown()).toBe("intro\n\n```\nx\n```\n\noutro");
});

it.each(["a```", "``", "`` `", "``~", "~~`"])(
  "leaves typed %s as paragraph text",
  async (line) => {
    const h = mount();
    await h.user.keyboard(`${line}{Shift>}{Enter}{/Shift}x`);
    expect(h.input.querySelector("pre")).toBeNull();
    expect(h.input).toHaveValue(`${line}\nx`);
    expect(h.markdown()).toBe(`${line}\nx`);
  },
);

it("does not convert a fence completed away from the end of its line", async () => {
  const h = mount("``");
  act(() => h.input.setSelectionRange(0, 0));
  await h.user.keyboard("`");
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input).toHaveValue("```");
  act(() => h.input.setSelectionRange(1, 1));
  await h.user.keyboard("`");
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input).toHaveValue("````");
});

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
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input.querySelector("code")).toHaveTextContent("```");
  act(() => {
    h.input.setSelectionRange(0, h.input.value.length);
    h.input.insertText("```\ncode\n```");
  });
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input).toHaveValue("```\ncode\n```");
  expect(h.markdown()).toBe("```\ncode\n```");
});

it("keeps a typed backtick that closes a pasted fence literal, then opens a new block from a fence typed below it", async () => {
  const h = mount();
  paste(h.input, "```\ncode\n``");
  expect(h.input).toHaveValue("```\ncode\n``");
  await h.user.keyboard("`");
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input).toHaveValue("```\ncode\n```");
  expect(h.markdown()).toBe("```\ncode\n```");
  // The pasted block is closed, so a fence typed under it opens a new one.
  await h.user.keyboard("{Shift>}{Enter}{/Shift}```more");
  expect(h.input.querySelectorAll("pre")).toHaveLength(1);
  expect(h.input.querySelector("pre > code")).toHaveTextContent("more");
  expect(h.input).toHaveValue("```\ncode\n```\nmore");
  expect(h.markdown()).toBe("```\ncode\n```\n\n```\nmore\n```");
});

it.each(["```js\ncode\n``", "~~~\ncode\n``", "````\n``"])(
  "keeps a backtick completing the closing or inner fence line of restored source %j literal",
  async (source) => {
    const h = mount(source);
    await h.user.keyboard("`");
    expect(h.input.querySelector("pre")).toBeNull();
    expect(h.input).toHaveValue(`${source}\``);
    expect(h.markdown()).toBe(`${source}\``);
  },
);

it("keeps a typed opening fence literal when a later line already closes it", async () => {
  const h = mount("``\ncode\n```");
  act(() => h.input.setSelectionRange(2, 2));
  await h.user.keyboard("`");
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input).toHaveValue("```\ncode\n```");
  expect(h.markdown()).toBe("```\ncode\n```");
});

/** Split the caret's empty last line into its own paragraph with the toolbar's
 * quote toggle and its lift, which leaves the split in place. Sibling paragraphs
 * send joined by one newline, so the wire is unchanged. */
function splitLastLine(h: ReturnType<typeof mount>, paragraphs: number) {
  act(() => h.input.toggleFormat("blockquote"));
  act(() => h.input.toggleFormat("blockquote"));
  expect(h.input.querySelector("blockquote")).toBeNull();
  expect(h.input.querySelectorAll(":scope > p")).toHaveLength(paragraphs);
}

it("keeps a fence literal that closes a block an earlier sibling paragraph opened, then converts below the closed block", async () => {
  const h = mount();
  await h.user.keyboard("```");
  act(() => h.input.undo(false));
  expect(h.input).toHaveValue("```");
  await h.user.keyboard("{Shift>}{Enter}{/Shift}code{Shift>}{Enter}{/Shift}");
  splitLastLine(h, 2);
  expect(h.markdown()).toBe("```\ncode\n");
  // The line closes the fence the first paragraph opened; on the wire the two
  // paragraphs are one fenced block, so the third backtick stays literal.
  await h.user.keyboard("```");
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input).toHaveValue("```\ncode\n```");
  expect(h.markdown()).toBe("```\ncode\n```");
  expect(fromMarkdown(h.markdown()).children).toMatchObject([
    { type: "code", value: "code" },
  ]);
  // Below the closed block, a fence in a further split paragraph opens one.
  await h.user.keyboard("{Shift>}{Enter}{/Shift}");
  splitLastLine(h, 3);
  await h.user.keyboard("```more");
  expect(h.input.querySelectorAll("pre")).toHaveLength(1);
  expect(h.input.querySelector("pre > code")).toHaveTextContent("more");
  expect(h.input).toHaveValue("```\ncode\n```\nmore");
  expect(h.markdown()).toBe("```\ncode\n```\n\n```\nmore\n```");
  expect(fromMarkdown(h.markdown()).children).toMatchObject([
    { type: "code", value: "code" },
    { type: "code", value: "more" },
  ]);
});

it("keeps a typed opening fence literal when a later sibling paragraph closes it", async () => {
  const h = mount("``");
  await h.user.keyboard("{Shift>}{Enter}{/Shift}");
  splitLastLine(h, 2);
  act(() => h.input.insertText("code\n```"));
  expect(h.input).toHaveValue("``\ncode\n```");
  act(() => h.input.setSelectionRange(2, 2));
  await h.user.keyboard("`");
  expect(h.input.querySelector("pre")).toBeNull();
  expect(h.input.querySelectorAll(":scope > p")).toHaveLength(2);
  expect(h.input).toHaveValue("```\ncode\n```");
  expect(h.markdown()).toBe("```\ncode\n```");
  expect(fromMarkdown(h.markdown()).children).toMatchObject([
    { type: "code", value: "code" },
  ]);
});

it.each([
  ["- ", "ul", "- "],
  ["* ", "ul", "- "],
  ["+ ", "ul", "- "],
  ["1. ", "ol", "1. "],
  ["1) ", "ol", "1. "],
  ["> ", "blockquote", "> "],
] as const)(
  "opens a block as the space of %j is typed, with one undo restoring the prefix",
  async (prefix, tag, wire) => {
    const h = mount();
    await h.user.keyboard(prefix.slice(0, -1));
    expect(h.input.querySelector(tag)).toBeNull();
    expect(h.input).toHaveValue(prefix.slice(0, -1));
    await h.user.keyboard(" ");
    expect(h.input.querySelector(`:scope > ${tag}`)).not.toBeNull();
    expect(h.input).toHaveValue("");
    act(() => h.input.undo(false));
    expect(h.input.querySelector(tag)).toBeNull();
    expect(h.input).toHaveValue(prefix);
    act(() => h.input.undo(true));
    expect(h.input.querySelector(`:scope > ${tag}`)).not.toBeNull();
    await h.user.keyboard("item");
    expect(h.input).toHaveValue("item");
    expect(h.markdown()).toBe(`${wire}item`);
    // The typed text is its own undo step; it never merges into the conversion.
    act(() => h.input.undo(false));
    expect(h.input.querySelector(`:scope > ${tag}`)).not.toBeNull();
    expect(h.input).toHaveValue("");
    act(() => h.input.undo(true));
    expect(h.markdown()).toBe(`${wire}item`);
    const saved = JSON.parse(JSON.stringify(h.draft()));
    act(() => h.input.reset(saved));
    expect(h.input.querySelector(`:scope > ${tag}`)).not.toBeNull();
    expect(h.markdown()).toBe(`${wire}item`);
  },
);

it("starts an ordered list at the typed number and continues it with Shift+Enter", async () => {
  const h = mount();
  await h.user.keyboard("3. third{Shift>}{Enter}{/Shift}fourth");
  expect(h.input.querySelector(":scope > ol")).toHaveAttribute("start", "3");
  expect(h.input.querySelectorAll("ol > li")).toHaveLength(2);
  expect(h.input).toHaveValue("third\nfourth");
  expect(h.markdown()).toBe("3. third\n4. fourth");
  await h.user.keyboard("{Tab}");
  expect(h.input.querySelector("ol ol > li")).toHaveTextContent("fourth");
  await h.user.keyboard("{Shift>}{Tab}{Enter}{Enter}{/Shift}outside");
  expect(h.input.querySelector(":scope > p")).toHaveTextContent("outside");
  expect(h.markdown()).toBe("3. third\n4. fourth\n\noutside");
  const saved = JSON.parse(JSON.stringify(h.draft()));
  act(() => h.input.reset(saved));
  expect(h.input.querySelector(":scope > ol")).toHaveAttribute("start", "3");
  expect(h.markdown()).toBe("3. third\n4. fourth\n\noutside");
});

it("opens a list from a marker typed on the second line, after the first line's paragraph", async () => {
  const h = mount("intro");
  await h.user.keyboard("{Shift>}{Enter}{/Shift}- item");
  expect(h.input.querySelector(":scope > p")).toHaveTextContent("intro");
  expect(h.input.querySelector(":scope > ul > li")).toHaveTextContent("item");
  expect(h.input).toHaveValue("intro\nitem");
  expect(h.markdown()).toBe("intro\n\n- item");
});

it("quotes the rest of the line when the marker is typed before existing prose", async () => {
  const h = mount("quoted\nplain");
  act(() => h.input.setSelectionRange(0, 0));
  await h.user.keyboard("> ");
  expect(h.input.querySelector(":scope > blockquote > p")).toHaveTextContent(
    "quoted",
  );
  expect(h.input.querySelector(":scope > p")).toHaveTextContent("plain");
  expect(h.input).toHaveValue("quoted\nplain");
  expect(h.markdown()).toBe("> quoted\n\nplain");
});

it("opens a list inside a quote but keeps a quote marker typed inside a list item literal, where the sent text still nests", async () => {
  const h = mount();
  await h.user.keyboard("> quote{Shift>}{Enter}{/Shift}- item");
  expect(
    h.input.querySelector(":scope > blockquote > ul > li"),
  ).toHaveTextContent("item");
  expect(h.markdown()).toBe("> quote\n>\n> - item");
  await h.user.keyboard("{Shift>}{Enter}{/Shift}> not nested");
  expect(h.input.querySelectorAll("blockquote")).toHaveLength(1);
  expect(h.input.querySelectorAll("ul > li")).toHaveLength(2);
  expect(h.input).toHaveValue("quote\nitem\n> not nested");
  expect(h.markdown()).toBe("> quote\n>\n> - item\n> - > not nested");
  // The composer shows the marker; the timeline reads a quote inside the item,
  // a shape the schema cannot hold because an item starts with a paragraph.
  expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
    type: "blockquote",
    children: [
      { type: "paragraph" },
      {
        type: "list",
        ordered: false,
        children: [
          { type: "listItem", children: [{ type: "paragraph" }] },
          {
            type: "listItem",
            children: [
              {
                type: "blockquote",
                children: [
                  {
                    type: "paragraph",
                    children: [{ type: "text", value: "not nested" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
});

it("nests a second quote as `> ` is typed inside a quote, with the toolbar, Shift+Enter and undo following the nesting", async () => {
  const h = mount();
  await h.user.keyboard("> outer{Shift>}{Enter}{/Shift}> inner");
  expect(
    h.input.querySelector(":scope > blockquote > blockquote > p"),
  ).toHaveTextContent("inner");
  expect(h.input.querySelectorAll("blockquote")).toHaveLength(2);
  expect(h.input).toHaveValue("outer\ninner");
  expect(h.markdown()).toBe("> outer\n>\n> > inner");
  expect(fromMarkdown(h.markdown()).children).toMatchObject([
    {
      type: "blockquote",
      children: [
        { type: "paragraph", children: [{ type: "text", value: "outer" }] },
        {
          type: "blockquote",
          children: [
            { type: "paragraph", children: [{ type: "text", value: "inner" }] },
          ],
        },
      ],
    },
  ]);
  // The toolbar reports one quote format, as it does for a single quote.
  expect(h.formats()).toEqual(["blockquote"]);
  // Shift+Enter continues the inner quote; an empty last line leaves it for
  // the outer quote, and once more leaves that.
  await h.user.keyboard(
    "{Shift>}{Enter}{/Shift}more{Shift>}{Enter}{Enter}{/Shift}back",
  );
  expect(
    h.input.querySelectorAll(":scope > blockquote > blockquote > p"),
  ).toHaveLength(2);
  expect(
    h.input.querySelector(":scope > blockquote > p:last-child"),
  ).toHaveTextContent("back");
  expect(h.formats()).toEqual(["blockquote"]);
  // Adjacent paragraphs send as lines of one paragraph, as in a single quote.
  expect(h.markdown()).toBe("> outer\n>\n> > inner\n> > more\n>\n> back");
  expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
    type: "blockquote",
    children: [
      { type: "paragraph" },
      {
        type: "blockquote",
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", value: "inner\nmore" }],
          },
        ],
      },
      { type: "paragraph", children: [{ type: "text", value: "back" }] },
    ],
  });
  await h.user.keyboard("{Shift>}{Enter}{Enter}{/Shift}outside");
  expect(h.input.querySelector(":scope > p")).toHaveTextContent("outside");
  expect(h.formats()).toEqual([]);
  // The toolbar's quote toggle lifts the caret's paragraph out of the inner
  // quote, one level at a time.
  act(() => h.input.setSelectionRange(8, 8));
  expect(h.formats()).toEqual(["blockquote"]);
  act(() => h.input.toggleFormat("blockquote"));
  expect(
    h.input.querySelectorAll(":scope > blockquote > blockquote > p"),
  ).toHaveLength(1);
  expect(
    h.input.querySelectorAll(":scope > blockquote > p")[1],
  ).toHaveTextContent("inner");
  const saved = JSON.parse(JSON.stringify(h.draft()));
  act(() => h.input.reset(saved));
  expect(h.markdown()).toBe(
    "> outer\n> inner\n>\n> > more\n>\n> back\n\noutside",
  );
});

it("restores the typed `> ` in one undo step when it nested a quote", async () => {
  const h = mount();
  await h.user.keyboard("> outer{Shift>}{Enter}{/Shift}> ");
  expect(h.input.querySelectorAll("blockquote")).toHaveLength(2);
  expect(h.input).toHaveValue("outer\n");
  act(() => h.input.undo(false));
  expect(h.input.querySelectorAll("blockquote")).toHaveLength(1);
  expect(h.input).toHaveValue("outer\n> ");
  act(() => h.input.undo(true));
  expect(
    h.input.querySelector(":scope > blockquote > blockquote > p"),
  ).not.toBeNull();
  await h.user.keyboard("inner");
  const saved = JSON.parse(JSON.stringify(h.draft()));
  act(() => h.input.reset(saved));
  expect(
    h.input.querySelector(":scope > blockquote > blockquote > p"),
  ).toHaveTextContent("inner");
  expect(h.markdown()).toBe("> outer\n>\n> > inner");
});

it.each([
  ["- ", "item", "- ", "ul", null, "- item\n  \n  - nested"],
  ["1. ", "one", "3. ", "ol", "3", "1. one\n   \n   3. nested"],
] as const)(
  "nests an empty item after the first as Tab does when %j%j is followed by %j",
  async (prefix, text, marker, tag, start, wire) => {
    const h = mount();
    await h.user.keyboard(`${prefix}${text}{Shift>}{Enter}{/Shift}${marker}`);
    const nested = h.input.querySelector(`:scope > ${tag} > li > ${tag}`);
    expect(nested?.querySelector("li")).not.toBeNull();
    expect(h.input.querySelectorAll("li")).toHaveLength(2);
    if (start) expect(nested).toHaveAttribute("start", start);
    else expect(nested).not.toHaveAttribute("start");
    expect(h.input).toHaveValue(`${text}\n`);
    act(() => h.input.undo(false));
    expect(h.input.querySelector(`${tag} ${tag}`)).toBeNull();
    expect(h.input.querySelectorAll(`:scope > ${tag} > li`)).toHaveLength(2);
    expect(h.input).toHaveValue(`${text}\n${marker}`);
    act(() => h.input.undo(true));
    await h.user.keyboard("nested");
    expect(h.input.querySelector(`${tag} ${tag} > li`)).toHaveTextContent(
      "nested",
    );
    expect(h.markdown()).toBe(wire);
    const ordered = tag === "ol";
    expect(fromMarkdown(wire).children).toMatchObject([
      {
        type: "list",
        ordered,
        children: [
          {
            type: "listItem",
            children: [
              { type: "paragraph", children: [{ type: "text", value: text }] },
              {
                type: "list",
                ordered,
                start: start ? Number(start) : null,
                children: [
                  {
                    type: "listItem",
                    children: [
                      {
                        type: "paragraph",
                        children: [{ type: "text", value: "nested" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const saved = JSON.parse(JSON.stringify(h.draft()));
    act(() => h.input.reset(saved));
    expect(
      h.input.querySelector(`:scope > ${tag} > li > ${tag}`),
    ).not.toBeNull();
    expect(h.markdown()).toBe(wire);
  },
);

it("joins the previous item's nested list as Tab does, so the typed number is a continuation there", async () => {
  const h = mount();
  await h.user.keyboard(
    "1. one{Shift>}{Enter}{/Shift}two{Tab}{Shift>}{Enter}{Enter}{/Shift}",
  );
  expect(h.input.querySelectorAll(":scope > ol > li")).toHaveLength(2);
  expect(h.input.querySelectorAll("ol ol > li")).toHaveLength(1);
  await h.user.keyboard("7. three");
  expect(h.input.querySelectorAll(":scope > ol > li")).toHaveLength(1);
  const nested = h.input.querySelector("ol ol");
  expect(nested).not.toHaveAttribute("start");
  expect(nested?.querySelectorAll("li")).toHaveLength(2);
  expect(h.input).toHaveValue("one\ntwo\nthree");
  expect(h.markdown()).toBe("1. one\n   \n   1. two\n   2. three");
  expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
    type: "list",
    start: 1,
    children: [
      {
        type: "listItem",
        children: [
          { type: "paragraph" },
          {
            type: "list",
            start: 1,
            children: [{ type: "listItem" }, { type: "listItem" }],
          },
        ],
      },
    ],
  });
});

it("keeps a marker of the other list kind, one beside an item's prose, and one in a first item literal, where the sent text still nests", async () => {
  const h = mount();
  await h.user.keyboard("- item{Shift>}{Enter}{/Shift}1. num");
  expect(h.input.querySelector("ol")).toBeNull();
  expect(h.input.querySelectorAll("ul > li")).toHaveLength(2);
  expect(h.input).toHaveValue("item\n1. num");
  expect(h.markdown()).toBe("- item\n- 1. num");
  expect(fromMarkdown(h.markdown()).children[0]).toMatchObject({
    type: "list",
    ordered: false,
    children: [
      { type: "listItem", children: [{ type: "paragraph" }] },
      {
        type: "listItem",
        children: [
          {
            type: "list",
            ordered: true,
            start: 1,
            children: [
              {
                type: "listItem",
                children: [
                  {
                    type: "paragraph",
                    children: [{ type: "text", value: "num" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const prose = mount();
  await prose.user.keyboard("- item{Shift>}{Enter}{/Shift}two");
  act(() => prose.input.setSelectionRange(5, 5));
  await prose.user.keyboard("- ");
  expect(prose.input.querySelector("ul ul")).toBeNull();
  expect(prose.input).toHaveValue("item\n- two");
  expect(prose.markdown()).toBe("- item\n- - two");
  const first = mount();
  await first.user.keyboard("- - nested");
  expect(first.input.querySelector("ul ul")).toBeNull();
  expect(first.input.querySelectorAll("li")).toHaveLength(1);
  expect(first.input).toHaveValue("- nested");
  expect(first.markdown()).toBe("- - nested");
  expect(fromMarkdown(first.markdown()).children[0]).toMatchObject({
    type: "list",
    children: [
      {
        type: "listItem",
        children: [
          {
            type: "list",
            children: [
              {
                type: "listItem",
                children: [
                  {
                    type: "paragraph",
                    children: [{ type: "text", value: "nested" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
});

it("caps continuation numbers at nine digits so the timeline reads one list", async () => {
  const h = mount();
  await h.user.keyboard("999999999. item{Shift>}{Enter}{/Shift}next");
  expect(h.input.querySelector(":scope > ol")).toHaveAttribute(
    "start",
    "999999999",
  );
  expect(h.input.querySelectorAll("ol > li")).toHaveLength(2);
  expect(h.markdown()).toBe("999999999. item\n999999999. next");
  expect(fromMarkdown(h.markdown()).children).toMatchObject([
    {
      type: "list",
      ordered: true,
      start: 999999999,
      children: [
        {
          type: "listItem",
          children: [
            { type: "paragraph", children: [{ type: "text", value: "item" }] },
          ],
        },
        {
          type: "listItem",
          children: [
            { type: "paragraph", children: [{ type: "text", value: "next" }] },
          ],
        },
      ],
    },
  ]);
});

it("alternates the marker between adjacent lists of one kind so they stay separate once sent", async () => {
  const h = mount();
  await h.user.keyboard(
    "3. third{Shift>}{Enter}{Enter}{/Shift}1. one{Shift>}{Enter}{/Shift}two",
  );
  expect(h.input.querySelectorAll(":scope > ol")).toHaveLength(2);
  expect(h.markdown()).toBe("3. third\n\n1) one\n2) two");
  expect(fromMarkdown(h.markdown()).children).toMatchObject([
    { type: "list", ordered: true, start: 3, children: [{ type: "listItem" }] },
    {
      type: "list",
      ordered: true,
      start: 1,
      children: [{ type: "listItem" }, { type: "listItem" }],
    },
  ]);
  const bullets = mount();
  await bullets.user.keyboard(
    "- a{Shift>}{Enter}{Enter}{/Shift}- b{Shift>}{Enter}{Enter}{/Shift}- c{Shift>}{Enter}{Enter}{/Shift}text{Shift>}{Enter}{/Shift}- d",
  );
  expect(bullets.input.querySelectorAll(":scope > ul")).toHaveLength(4);
  expect(bullets.markdown()).toBe("- a\n\n* b\n\n- c\n\ntext\n\n- d");
  expect(
    fromMarkdown(bullets.markdown()).children.map((node) => node.type),
  ).toEqual(["list", "list", "list", "paragraph", "list"]);
});

it.each([
  ["- ", "ul", "- a\n\n* b\n\n\n\n- c"],
  ["1. ", "ol", "1. a\n\n1) b\n\n\n\n1. c"],
] as const)(
  "keeps alternating %j list markers across an empty paragraph so three lists stay three",
  async (marker, tag, wire) => {
    const h = mount();
    // Two Shift+Enters leave the list; a third on the empty paragraph adds a
    // blank line, which the marker's conversion splits into its own paragraph.
    await h.user.keyboard(
      `${marker}a{Shift>}{Enter}{Enter}{/Shift}${marker}b{Shift>}{Enter}{Enter}{Enter}{/Shift}${marker}c`,
    );
    expect(h.input.querySelectorAll(`:scope > ${tag}`)).toHaveLength(3);
    expect(h.input.querySelectorAll(":scope > p")).toHaveLength(1);
    expect(h.markdown()).toBe(wire);
    expect(fromMarkdown(h.markdown()).children).toMatchObject([
      { type: "list", children: [{ type: "listItem" }] },
      { type: "list", children: [{ type: "listItem" }] },
      { type: "list", children: [{ type: "listItem" }] },
    ]);
  },
);

it("leaves a marker typed after prose, and ordinary spaces, as paragraph text", async () => {
  const h = mount();
  await h.user.keyboard("note - one 1. two > three");
  expect(h.input.querySelector("ul, ol, blockquote")).toBeNull();
  expect(h.input).toHaveValue("note - one 1. two > three");
  expect(h.markdown()).toBe("note - one 1. two > three");
});

it.each([" - ", "a- ", "1.5 ", "1234567890. ", "-> ", ">> "])(
  "leaves typed %j as paragraph text",
  async (line) => {
    const h = mount();
    await h.user.keyboard(line);
    expect(h.input.querySelector("ul, ol, blockquote")).toBeNull();
    expect(h.input).toHaveValue(line);
  },
);

it("keeps a marker typed inside a code block or inline code literal", async () => {
  const h = mount();
  act(() => h.input.toggleFormat("code_block"));
  await h.user.keyboard("- item");
  expect(h.input.querySelector("ul")).toBeNull();
  expect(h.input.querySelector("pre > code")).toHaveTextContent("- item");
  expect(h.markdown()).toBe("```\n- item\n```");
  const inline = mount();
  act(() => inline.input.toggleFormat("code"));
  await inline.user.keyboard("> quote");
  expect(inline.input.querySelector("blockquote")).toBeNull();
  expect(inline.input.querySelector("code")).toHaveTextContent("> quote");
  expect(inline.markdown()).toBe("`> quote`");
});

it("does not convert an inserted or pasted marker, or one typed inside pasted fenced source", async () => {
  const h = mount();
  act(() => h.input.insertText("- item"));
  expect(h.input.querySelector("ul")).toBeNull();
  expect(h.markdown()).toBe("- item");
  paste(h.input, "\n> quote");
  expect(h.input.querySelector("blockquote")).toBeNull();
  expect(h.markdown()).toBe("- item\n> quote");
  const fenced = mount();
  paste(fenced.input, "```\ncode\n```");
  act(() => fenced.input.setSelectionRange(4, 4));
  await fenced.user.keyboard("- ");
  expect(fenced.input.querySelector("ul, pre")).toBeNull();
  expect(fenced.input).toHaveValue("```\n- code\n```");
  expect(fenced.markdown()).toBe("```\n- code\n```");
  // A fence left open by an earlier sibling paragraph still covers the line.
  const split = mount();
  await split.user.keyboard("```");
  act(() => split.input.undo(false));
  await split.user.keyboard("{Shift>}{Enter}{/Shift}");
  splitLastLine(split, 2);
  await split.user.keyboard("- item");
  expect(split.input.querySelector("ul, pre")).toBeNull();
  expect(split.input).toHaveValue("```\n- item");
  expect(split.markdown()).toBe("```\n- item");
});

it("keeps a marker literal on a line holding a mention chip", async () => {
  const h = mount();
  const honey = { pubkey: "a".repeat(64), name: "Honey" };
  act(() => h.input.insertText("", honey));
  expect(h.input).toHaveValue("@Honey ");
  act(() => h.input.setSelectionRange(0, 0));
  await h.user.keyboard("- ");
  expect(h.input.querySelector("ul")).toBeNull();
  expect(h.input).toHaveValue("- @Honey ");
  expect(h.input.querySelector('[data-source="@Honey"]')).not.toBeNull();
  expect(h.draft().recipients).toEqual([{ ...honey, start: 2, end: 8 }]);
  expect(h.markdown()).toBe("- @Honey ");
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

/** A character the host's native text-input path can commit as typed text for
 * a caret or function key. The desktop build committed U+001D on every Right
 * Arrow press: a key's raw keyboard-layout translation is a C0 control (the
 * arrows are U+001C through U+001F), which WebKit does not strip from a key
 * event's text. AppKit's own NSEvent carries the private-use function-key
 * character instead (NSUpArrowFunctionKey U+F700 onwards), which WebKit strips
 * and the guard refuses as well. DEL and the C1 controls are as glyphless. */
const controlKeys = [
  ["Left Arrow's layout translation U+001C", "\u001C"],
  ["Right Arrow's layout translation U+001D", "\u001D"],
  ["Up Arrow's layout translation U+001E", "\u001E"],
  ["Down Arrow's layout translation U+001F", "\u001F"],
  ["Home's layout translation U+0001", "\u0001"],
  ["End's layout translation U+0004", "\u0004"],
  ["Page Up's layout translation U+000B", "\u000B"],
  ["Page Down's layout translation U+000C", "\u000C"],
  ["DEL U+007F", "\u007F"],
  ["the first C1 control U+0080", "\u0080"],
  ["the last C1 control U+009F", "\u009F"],
  ["Up Arrow's function-key character U+F700", "\uF700"],
  ["Down Arrow's function-key character U+F701", "\uF701"],
  ["Left Arrow's function-key character U+F702", "\uF702"],
  ["Right Arrow's function-key character U+F703", "\uF703"],
  ["F1's function-key character U+F704", "\uF704"],
  ["Home's function-key character U+F729", "\uF729"],
  ["End's function-key character U+F72B", "\uF72B"],
  ["Page Up's function-key character U+F72C", "\uF72C"],
  ["Page Down's function-key character U+F72D", "\uF72D"],
] as const;
/** Right Arrow committed as text in both forms the host can produce. Each
 * carries a label because neither character has a glyph: interpolated raw
 * into a case name or an assertion message they read identically. */
const rightArrowCharacters = [
  ["Right Arrow's layout translation U+001D", "\u001D"],
  ["Right Arrow's function-key character U+F703", "\uF703"],
] as const;
const caretKeys = [
  "ArrowRight",
  "ArrowLeft",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "Shift",
  "Meta",
  "Escape",
] as const;

/** Everything the composer persists or shows: the draft with its document
 * snapshot, and the rendered DOM. */
function snapshot(h: ReturnType<typeof mount>) {
  return { draft: JSON.stringify(h.draft()), html: h.input.innerHTML };
}

/** Presses a caret key: through user-event where it models the key, and as a
 * bare keydown/keyup pair for Home and End, whose caret movement jsdom does
 * not implement on a contenteditable element. */
async function press(h: ReturnType<typeof mount>, key: string) {
  if (key !== "Home" && key !== "End") {
    await h.user.keyboard(`{${key}}`);
    return;
  }
  const target = document.activeElement ?? h.input;
  fireEvent.keyDown(target, { key, code: key });
  fireEvent.keyUp(target, { key, code: key });
}

/** The browser's own insertion of text the host committed: a cancelable
 * beforeinput, then the DOM change ProseMirror observes. With `beforeinput`
 * false the change arrives as an uncancelable or unannounced one would.
 * Returns whether the DOM was changed. */
function nativeInsert(
  input: ComposerInputElement,
  text: string,
  beforeinput = true,
) {
  let inserted = false;
  act(() => {
    input.focus();
    if (
      beforeinput &&
      !input.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: text,
        }),
      )
    )
      return;
    const selection = document.getSelection();
    const focus = selection?.focusNode;
    if (!selection || !focus) throw new Error("DOM selection unavailable");
    let node: Text;
    let offset = selection.focusOffset;
    if (focus instanceof Text) node = focus;
    else {
      node = document.createTextNode("");
      focus.insertBefore(node, focus.childNodes[offset] ?? null);
      offset = 0;
    }
    node.insertData(offset, text);
    selection.collapse(node, offset + text.length);
    inserted = true;
  });
  return inserted;
}

it.each(controlKeys)(
  "refuses %s committed as text at both native seams",
  async (_label, character) => {
    const h = mount("abc");
    const before = snapshot(h);
    // The cancelable seam: the DOM never changes.
    expect(nativeInsert(h.input, character)).toBe(false);
    expect(snapshot(h)).toEqual(before);
    // The observed seam: an insertion that arrived anyway is redrawn away.
    expect(nativeInsert(h.input, character, false)).toBe(true);
    await waitFor(() => expect(h.input.textContent).toBe("abc"));
    expect(snapshot(h)).toEqual(before);
    expect(h.input.selectionStart).toBe(3);
    expect(h.input.selectionEnd).toBe(3);
    await h.user.keyboard("d");
    expect(h.input).toHaveValue("abcd");
    expect(h.markdown()).toBe("abcd");
  },
);

it.each([
  ["a tab", "\t", "abc\t"],
  ["a newline", "\n", "abc\n"],
  // ProseMirror's DOM parser reads a carriage return as a newline.
  ["a carriage return", "\r", "abc\n"],
  // No key yields a control character beside real text; such text is left
  // alone rather than reshaped under the native selection that describes it.
  ["a control character beside real text, whole", "a\u001D", "abca\u001D"],
])("still inserts %s committed as text", async (_label, text, value) => {
  const h = mount("abc");
  expect(nativeInsert(h.input, text)).toBe(true);
  await waitFor(() => expect(h.input).toHaveValue(value));
  expect(h.draft().text).toBe(value);
  expect(h.input.selectionStart).toBe(value.length);
  expect(h.input.selectionEnd).toBe(value.length);
});

it.each([
  ["after text", async (h: ReturnType<typeof mount>) => h.input.value],
  [
    "on an empty trailing paragraph",
    async (h: ReturnType<typeof mount>) => {
      await h.user.keyboard("{Shift>}{Enter}{/Shift}");
      expect(h.input).toHaveValue("abc\n");
      return h.input.value;
    },
  ],
  [
    "directly after a mention chip",
    async (h: ReturnType<typeof mount>) => {
      act(() =>
        h.input.insertText("", { pubkey: "a".repeat(64), name: "Honey" }),
      );
      expect(h.input).toHaveValue("abc@Honey ");
      act(() => h.input.setSelectionRange(9, 9));
      return "abc@Honey ";
    },
  ],
  [
    "inside a list item",
    async (h: ReturnType<typeof mount>) => {
      await h.user.keyboard("{Shift>}{Enter}{/Shift}- item");
      expect(h.input.querySelector("ul > li")).toHaveTextContent("item");
      return h.input.value;
    },
  ],
])(
  "keeps the document unchanged by caret keys %s, and by a Right Arrow committed as text in either form",
  async (_context, setup) => {
    const h = mount("abc");
    const value = await setup(h);
    const before = snapshot(h);
    const start = h.input.selectionStart;
    for (const key of caretKeys) {
      await press(h, key);
      expect(snapshot(h), key).toEqual(before);
      expect(h.input.selectionStart, key).toBe(h.input.selectionEnd);
    }
    for (const [label, character] of rightArrowCharacters) {
      act(() => h.input.setSelectionRange(start, start));
      expect(nativeInsert(h.input, character), label).toBe(false);
      expect(snapshot(h), label).toEqual(before);
      expect(nativeInsert(h.input, character, false), label).toBe(true);
      await waitFor(() =>
        expect(h.input.textContent, label).not.toContain(character),
      );
      expect(snapshot(h), label).toEqual(before);
    }
    expect(h.input).toHaveValue(value);
    expect(h.draft().recipients.map((item) => item.name)).toEqual(
      value.includes("@Honey") ? ["Honey"] : [],
    );
  },
);

it.each(rightArrowCharacters)(
  "never runs a typed conversion for %s committed as text",
  async (_label, character) => {
    const h = mount();
    await h.user.keyboard("**a*");
    const before = snapshot(h);
    expect(nativeInsert(h.input, character, false)).toBe(true);
    await waitFor(() => expect(h.input.textContent).toBe("**a*"));
    expect(snapshot(h)).toEqual(before);
    await h.user.keyboard("*");
    expect(h.input.querySelector("strong")).toHaveTextContent("a");
    expect(h.markdown()).toBe("**a**");
  },
);
