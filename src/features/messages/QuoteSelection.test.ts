// @vitest-environment jsdom
import { npubEncode } from "nostr-tools/nip19";
import { afterEach, describe, expect, it } from "vitest";
import { projectComposerDocument } from "./composer-document";
import { composerMarkdown } from "./composer-markdown";
import { quotableSelection } from "./QuoteSelection";

const person = "a".repeat(64);
const mention = `<button type="button" data-mention-kind="person" data-profile-target="nostr:${npubEncode(person)}" data-mention-name="Morgan">Morgan</button>`;
const row = (id: string, body: string) =>
  `<div data-message-id="${id}"><span>Author</span><div data-message-body="">${body}</div></div>`;

function scroller(html: string) {
  document.body.innerHTML = `<section data-message-scroller="">${html}</section>`;
  return document.querySelector("[data-message-scroller]") as Element;
}

function select(
  start: Node,
  startOffset: number,
  end: Node,
  endOffset: number,
) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = document.getSelection() as Selection;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

const text = (selector: string) =>
  document.querySelector(selector)?.firstChild as Text;

function quoted(root: Element, selection: Selection) {
  const doc = quotableSelection(root, selection)?.doc;
  return doc && projectComposerDocument(doc).draft;
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

describe("quote selection", () => {
  it("quotes part of one message as a quote followed by a reply line", () => {
    const root = scroller(
      row("m1", "<p id='a'>First line</p><p>Second line</p>"),
    );
    const second = document.querySelector("#a + p")?.firstChild as Text;
    const draft = quoted(root, select(text("#a"), 6, second, 6));
    expect(draft && composerMarkdown(draft)).toBe("> line\n>\n> Second\n\n");
  });

  it("keeps a quoted mention as text that notifies no one", () => {
    const root = scroller(row("m1", `<p id="a">Ask ${mention} today</p>`));
    const paragraph = document.querySelector("#a") as Element;
    const draft = quoted(
      root,
      select(paragraph, 0, paragraph, paragraph.childNodes.length),
    );
    expect(draft?.recipients).toEqual([]);
    expect(draft?.text).toContain("Morgan");
  });

  it("offers nothing for a selection across two messages", () => {
    const root = scroller(
      `${row("m1", "<p id='a'>One</p>")}${row("m2", "<p id='b'>Two</p>")}`,
    );
    expect(
      quotableSelection(root, select(text("#a"), 0, text("#b"), 3)),
    ).toBeNull();
  });

  it("quotes only the body when a triple-click ends at the next message", () => {
    const root = scroller(
      `${row("m1", "<p id='a'>Whole paragraph</p>")}<div data-message-id="m2"><p id="b">Next</p></div>`,
    );
    const next = document.querySelector("#b") as Element;
    const draft = quoted(root, select(text("#a"), 0, next, 0));
    expect(draft && composerMarkdown(draft)).toBe("> Whole paragraph\n\n");
  });

  it("offers nothing for a selection of only chrome that copies omit", () => {
    const root = scroller(
      row(
        "m1",
        `<p>Body<span id="e" style="user-select: none"> (edited)</span></p>`,
      ),
    );
    expect(
      quotableSelection(root, select(text("#e"), 1, text("#e"), 9)),
    ).toBeNull();
  });

  it("offers nothing outside a message body or in a nested timeline", () => {
    const root = scroller(
      `${row("m1", "<p>Body</p>")}<section data-message-scroller="">${row("m2", "<p id='nested'>Nested</p>")}</section>`,
    );
    const author = document.querySelector("span")?.firstChild as Text;
    expect(quotableSelection(root, select(author, 0, author, 6))).toBeNull();
    expect(
      quotableSelection(root, select(text("#nested"), 0, text("#nested"), 6)),
    ).toBeNull();
  });
});
