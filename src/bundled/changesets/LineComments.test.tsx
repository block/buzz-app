// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SelectedLineRange } from "@pierre/diffs";
import type { DiffAnnotations } from "../diffs/DiffViewer";
import { parsePatch } from "../diffs/parse";
import { createComments, formatComment } from "./comments";
import { changesIn } from "./LineComments";
import { ChangesetPanel } from "./Panel";
import { targetFor } from "./target";
import type { Turn, Turns } from "./turns";

afterEach(cleanup);

// The real viewer draws lines in a shadow root and selects them with pointer
// gestures; the browser journey covers that. Here a stand-in shows the
// annotations and hands out the selection callback.
let select: (range: SelectedLineRange | null) => void = () => {};
vi.mock("../diffs/DiffViewer", () => ({
  DiffViewer: ({ annotate }: { annotate?: DiffAnnotations }) => {
    if (!annotate) return null;
    select = annotate.onSelect;
    return (
      <div data-testid="diff">
        {annotate.lineAnnotations.map((annotation) => (
          <div
            key={`${annotation.side}:${annotation.lineNumber}:${annotation.metadata}`}
          >
            {annotate.renderAnnotation(annotation)}
          </div>
        ))}
      </div>
    );
  },
}));

const PATCH = [
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,3 +1,3 @@",
  " keep",
  "-old",
  "+new",
  " tail",
  "",
].join("\n");
const turn: Turn = {
  id: "t1",
  agent: "A",
  channelId: "c",
  viewer: "me",
  origin: "o",
  start: 1,
  end: 2,
  checkouts: [
    {
      dir: "/work/app",
      prefix: "",
      label: "app (main)",
      before: "a".repeat(40),
      after: "b".repeat(40),
      files: 1,
    },
  ],
};
const turns = {
  subscribe: () => () => {},
  version: () => 0,
  summary: async () => [
    {
      path: "a.txt",
      status: "modified",
      additions: 1,
      deletions: 1,
      binary: false,
    },
  ],
  patch: async () => PATCH,
  find: () => ({ turn, checkout: turn.checkouts[0] }),
} as unknown as Turns;

function panel(send: (turn: Turn, text: string) => void = vi.fn()) {
  const comments = createComments();
  render(
    <ChangesetPanel
      target={targetFor("t1", 0, "a.txt")}
      turns={turns}
      comments={comments}
      send={send}
    />,
  );
  return comments;
}

const ADDED = "additions" as const;
const REMOVED = "deletions" as const;

async function comment(range: SelectedLineRange, text: string) {
  // The file list arrives before its patch; wait for the diff itself.
  await screen.findByTestId("diff");
  act(() => select(range));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

it("sends each comment on a range of lines to the turn's agent at once", async () => {
  const send = vi.fn();
  const comments = panel(send);
  await comment({ start: 1, side: ADDED, end: 2 }, "Rename this");
  expect(send).toHaveBeenLastCalledWith(
    turn,
    "Comment on `a.txt` lines 1-2, in `app`:\n```diff\n keep\n-old\n+new\n```\nRename this",
  );
  expect(
    screen.getByRole("region", { name: "Comment on lines 1-2" }),
  ).toHaveTextContent("Rename this");
  expect(screen.queryByRole("textbox")).toBeNull();
  await comment({ start: 2, side: REMOVED, end: 2 }, "Keep `old`");
  expect(send).toHaveBeenLastCalledWith(
    turn,
    "Comment on `a.txt` removed line 2, in `app`:\n```diff\n-old\n```\nKeep `old`",
  );
  expect(comments.list("t1:0")).toEqual([
    expect.objectContaining({ at: { side: ADDED, line: 2 } }),
    expect.objectContaining({ at: { side: REMOVED, line: 2 } }),
  ]);
});

it("keeps the comment open and says why when it can't be sent", async () => {
  const comments = panel(() => {
    throw new Error(
      "Switch to the community and account this changeset was recorded in, then try again.",
    );
  });
  await comment({ start: 3, side: ADDED, end: 3 }, "Why?");
  expect(screen.getByRole("textbox")).toHaveValue("Why?");
  expect(screen.getByText(/Switch to the community/)).toBeInTheDocument();
  expect(comments.list("t1:0")).toHaveLength(0);
});

it("cancels a comment with Escape and sends nothing", async () => {
  const send = vi.fn();
  panel(send);
  // The file list arrives before its patch; wait for the diff itself.
  await screen.findByTestId("diff");
  act(() => select({ start: 3, side: ADDED, end: 3 }));
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(send).not.toHaveBeenCalled();
});

it("finds the changes a selection covers across both sides", () => {
  const changes = (parsePatch(PATCH)?.[0]?.hunks ?? []).flatMap(
    (hunk) => hunk.changes,
  );
  const covered = (range: SelectedLineRange) =>
    changesIn(changes, range).map((change) => change.content);
  expect(covered({ start: 2, side: REMOVED, end: 3, endSide: ADDED })).toEqual([
    "old",
    "new",
    "tail",
  ]);
  expect(covered({ start: 3, side: ADDED, end: 1 })).toEqual([
    "keep",
    "old",
    "new",
    "tail",
  ]);
  expect(covered({ start: 9, side: ADDED, end: 9 })).toEqual([]);
});

it("fences quoted code past its own backticks and shortens long quotes", () => {
  const code = ["+```js", ...Array.from({ length: 8 }, (_, i) => `+${i}`)];
  expect(
    formatComment("/w", {
      path: "a.md",
      at: { side: ADDED, line: 9 },
      lines: "lines 1-9",
      code,
      text: " Hi ",
    }),
  ).toBe(
    [
      "Comment on `a.md` lines 1-9, in `/w`:",
      "````diff",
      "+```js",
      "+0",
      "+1",
      "+2",
      "+3",
      "+4",
      " …",
      "````",
      "Hi",
    ].join("\n"),
  );
});

it("keeps quoted lines short and code spans whole", () => {
  expect(
    formatComment("my`app", {
      path: "a`b.ts",
      at: { side: ADDED, line: 1 },
      lines: "line 1",
      code: [`+${"x".repeat(400)}`],
      text: "Hi",
    }),
  ).toBe(
    [
      "Comment on `` a`b.ts `` line 1, in `` my`app ``:",
      "```diff",
      `+${"x".repeat(299)} …`,
      "```",
      "Hi",
    ].join("\n"),
  );
});
