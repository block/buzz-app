// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Node as EditorNode } from "prosemirror-model";
import { MessageMarkdown } from "./MessageMarkdown";
import {
  composerSchema as schema,
  projectComposerDocument,
  readComposerDocument,
  readComposerSnapshot,
} from "./composer-document";
import { composerMarkdown } from "./composer-markdown";
import { withTables } from "./composer-table";
import { mentionDraft } from "./mention-draft";

type Grid = { align: (string | null)[]; cells: string[][] };

const author = "a".repeat(64);

function timeline(content: string) {
  const html = renderToStaticMarkup(
    <MessageMarkdown
      row={{
        id: "message",
        channelId: "channel",
        authorId: author,
        content,
        createdAt: 1,
        mentions: [],
        participants: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
        emoji: [],
      }}
      media={() => undefined}
      onOpenLink={() => false}
      canOpenLink={() => false}
      participantProfiles={new Map()}
    />,
  );
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

function timelineGrids(content: string): Grid[] {
  return Array.from(timeline(content).querySelectorAll("table")).map(
    (found) => ({
      align: Array.from(found.querySelector("tr")?.children ?? []).map(
        (cell) => (cell as HTMLElement).style.textAlign || null,
      ),
      cells: Array.from(found.querySelectorAll("tr")).map((tr) =>
        Array.from(tr.children).map((cell) => cell.textContent ?? ""),
      ),
    }),
  );
}

function timelineBlocks(content: string) {
  return Array.from(timeline(content).querySelector("div")?.children ?? [])
    .filter((node) => node.tagName !== "TABLE")
    .map((node) => `${node.tagName}:${node.textContent}`);
}

function editorGrids(root: EditorNode): Grid[] {
  const found: Grid[] = [];
  root.forEach((block) => {
    if (block.type !== schema.nodes.table) return;
    const rows = Array.from({ length: block.childCount }, (_, r) =>
      block.child(r),
    );
    const head = rows[0];
    found.push({
      align: head
        ? Array.from({ length: head.childCount }, (_, c) => {
            const align = head.child(c).attrs.align as string | null;
            return align;
          })
        : [],
      cells: rows.map((row) =>
        Array.from(
          { length: row.childCount },
          (_, c) => row.child(c).textContent,
        ),
      ),
    });
  });
  return found;
}

const load = (source: string) =>
  withTables(
    readComposerDocument(mentionDraft({ text: source, recipients: [] }), []),
  );
const send = (root: EditorNode) =>
  composerMarkdown(projectComposerDocument(root).draft);
const wide = (n: number, fill: (c: number) => string) =>
  `| ${Array.from({ length: n }, (_, c) => fill(c)).join(" | ")} |`;

const plain: Record<string, string> = {
  "outer pipes": "| a | b |\n| - | - |\n| 1 | 2 |",
  "leading pipes only": "| a | b\n| - | -\n| 1 | 2",
  "trailing pipes only": "a | b |\n- | - |\n1 | 2 |",
  "no outer pipes": "a | b\n--- | ---\n1 | 2",
  "tight pipes": "|a|b|\n|:-:|--:|\n|1|2|",
  "alignment of every kind":
    "| a | b | c | d |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |",
  "long alignment rule": "| a | b |\n| :------ | ------: |\n| 1 | 2 |",
  "short alignment rule": "| a | b |\n| :- | -: |\n| 1 | 2 |",
  "header only": "| a | b |\n| - | - |",
  "single column": "| a |\n| - |\n| 1 |\n| 2 |",
  "short body rows": "| a | b |\n| - | - |\n| 1 |\n| 2 | 3 |",
  "long body rows": "| a | b |\n| - | - |\n| 1 | 2 | 3 |",
  "empty cells": "| a |  | c |\n| - | - | - |\n|  | 2 |  |",
  "adjacent pipes": "| A || C |\n| - | - | - |\n| a || c |",
  "trailing spaces after a row": "| a | b |  \n| - | - |  \n| 1 | 2 |  ",
  "indented by three spaces": "   | a | b |\n   | - | - |\n   | 1 | 2 |",
  "tabs around cells": "|\ta\t|\tb\t|\n|\t-\t|\t-\t|\n|\t1\t|\t2\t|",
  "escaped pipe": "| a \\| b | c |\n| - | - |\n| 1 | 2 |",
  "escaped backslash then pipe": "| a \\\\| b | c |\n| - | - |",
  "backslash at the end of a cell": "| a \\ | b |\n| - | - |\n| 1 \\ | 2 |",
  "line break tag": "| a<br>b | c |\n| - | - |",
  "emoji and non-BMP text":
    "| \u{1F600} | \u{1D11E} x |\n| - | - |\n| é | 日本 |",
  "many columns": `${wide(30, (c) => `c${c}`)}\n${wide(30, () => "-")}\n${wide(30, (c) => `${c}`)}`,
  "after a heading": "# Title\n\n| a | b |\n| - | - |\n| 1 | 2 |",
  "before a rule": "| a | b |\n| - | - |\n\n---\n\ntext",
  "after a rule": "text\n\n---\n\n| a | b |\n| - | - |",
  "between paragraphs": "before\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nafter",
  "before a list": "| a |\n| - |\n\n- one\n- two",
  "after a list": "- one\n- two\n\n| a |\n| - |",
  "before a quote": "| a |\n| - |\n\n> quoted",
  "after a quote": "> quoted\n\n| a |\n| - |",
  "before a code block": "| a |\n| - |\n\n```\ncode\n```",
  "after a code block": "```\ncode\n```\n\n| a |\n| - |",
  "two tables": "| a |\n| - |\n| 1 |\n\n| b |\n| - |\n| 2 |",
  "two tables with a gap": "| a |\n| - |\n\n\n\n\n| b |\n| - |",
  "a delimiter-like cell": "| a | b |\n| - | - |\n| - | :-- |",
};

const marked: Record<string, string> = {
  "code span": "| `x` | c |\n| - | - |\n| `a\\|b` | `c` |",
  "pipe in a link address":
    "| [a](https://example.com/?q=a%7Cb) | c |\n| - | - |",
  "escaped backslash at the end of a cell":
    "| a \\\\ | b |\n| - | - |\n| 1 \\\\ | 2 |",
  "html entity": "| &amp; | &#124; |\n| - | - |",
  emphasis: "| *a* | **b** |\n| - | - |\n| ~~c~~ | _d_ |",
  "task marker": "| [ ] a | [x] b |\n| - | - |",
  "spoiler text": "| ||secret|| | b |\n| - | - |",
};

describe("tables survive loading, sending and reloading", () => {
  it.each(Object.entries(plain))("%s", (_name, source) => {
    const loaded = load(source);
    const sent = send(loaded);
    expect(editorGrids(loaded)).toEqual(timelineGrids(source));
    expect(timelineGrids(sent)).toEqual(timelineGrids(source));
    expect(timelineBlocks(sent)).toEqual(timelineBlocks(source));
    expect(send(load(sent))).toBe(sent);
    const snapshot = JSON.parse(
      JSON.stringify(projectComposerDocument(loaded).draft),
    ).document;
    const restored = readComposerSnapshot(snapshot);
    expect(restored?.eq(loaded)).toBe(true);
    expect(restored && send(restored)).toBe(sent);
  });

  it.each(Object.entries(marked))("%s", (_name, source) => {
    const loaded = load(source);
    const sent = send(loaded);
    expect(timelineGrids(sent)).toEqual(timelineGrids(source));
    expect(send(load(sent))).toBe(sent);
  });

  it("starts a line glued under a table as another row, as the timeline does", () => {
    const source = "| a | b |\n| - | - |\n| 1 | 2 |\nglued";
    const sent = send(load(source));
    expect(timelineGrids(sent)).toEqual(timelineGrids(source));
    expect(timelineGrids(sent)[0]?.cells.at(-1)?.[0]).toBe("glued");
    expect(send(load(sent))).toBe(sent);
  });

  it("separates a paragraph from the table before and after it with a blank line", () => {
    const sent = send(load("intro\n\n| a |\n| - |\n\noutro"));
    expect(sent).toBe("intro\n\n| a |\n| --- |\n\noutro");
  });
});
