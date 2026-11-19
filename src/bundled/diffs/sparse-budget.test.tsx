// @vitest-environment jsdom
import * as pierre from "@pierre/diffs";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DiffViewer } from "./DiffViewer";
import { parsePatch } from "./parse";

vi.mock("@pierre/diffs", async (importOriginal) => {
  const original = await importOriginal<typeof pierre>();
  return {
    ...original,
    preloadHighlighter: vi.fn(original.preloadHighlighter),
  };
});

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const header =
  "diff --git a/sample.kt b/sample.kt\n--- a/sample.kt\n+++ b/sample.kt\n";
it.each([
  ["modified", "@@ -5181 +5181 @@\n-val n = 1\n+val n = 2\n", 5181],
  ["added", "@@ -0,0 +2000,2 @@\n+val a = 1\n+val b = 2\n", 2001],
  ["deleted", "@@ -2000,2 +0,0 @@\n-val a = 1\n-val b = 2\n", 2001],
  [
    "widely separated",
    "@@ -1 +1 @@\n-val a = 1\n+val a = 2\n@@ -1000000000 +1000000000 @@\n-val b = 1\n+val b = 2\n",
    1000000000,
  ],
])(
  "renders %s lines using patch size rather than absolute offsets",
  async (_name, hunks, lastLine) => {
    const content = header + hunks;
    const files = parsePatch(content);
    expect(files).toHaveLength(1);
    const metadata = pierre.parsePatchFiles(content)[0]?.files[0];
    expect(metadata?.isPartial).toBe(true);
    expect(metadata?.additionLines.length).toBeLessThanOrEqual(2);
    expect(metadata?.deletionLines.length).toBeLessThanOrEqual(2);
    const { container } = render(
      <DiffViewer content={content} files={files} />,
    );
    await vi.waitFor(() => {
      const root = container.querySelector("diffs-container")?.shadowRoot;
      expect(root?.querySelector(`pre [data-line="${lastLine}"]`)).toBeTruthy();
      expect(
        root?.querySelectorAll("pre [data-line]").length,
      ).toBeLessThanOrEqual(4);
    });
    expect(screen.queryByRole("region", { name: "Raw diff" })).toBeNull();
    expect(pierre.preloadHighlighter).toHaveBeenCalled();
  },
);

it.each([
  ["line count", `@@ -1,501 +1,501 @@\n${" val n = 1\n".repeat(501)}`],
  ["line length", `@@ -1 +1 @@\n ${"x".repeat(2001)}\n`],
  [
    "character count",
    `@@ -1,13 +1,13 @@\n${` ${"x".repeat(1000)}\n`.repeat(13)}`,
  ],
])(
  "keeps patches over the %s budget raw before highlighting",
  (_name, hunks) => {
    const content = header + hunks;
    const files = parsePatch(content);
    expect(files).toHaveLength(1);
    const { container } = render(
      <DiffViewer content={content} files={files} />,
    );
    expect(screen.getByRole("region", { name: "Raw diff" }).textContent).toBe(
      content,
    );
    expect(container.querySelector("diffs-container")).toBeNull();
    expect(pierre.preloadHighlighter).not.toHaveBeenCalled();
  },
);
