// @vitest-environment jsdom
import { createHash } from "node:crypto";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Code, CodeReader } from "./code";
import { CodePreview } from "./CodePreview";
import type { GitHubComment } from "./gh";

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
  vi.unstubAllGlobals();
});

const base = "https://github.com/example-org/sample";
const text = Array.from({ length: 30 }, (_, i) => `const v${i + 1} = ${i + 1};`)
  .join("\n")
  .concat("\n");

function reader(code: Code | Error = { ref: "main", path: "src/a.ts", text }) {
  return {
    read: vi.fn(async () => {
      if (code instanceof Error) throw code;
      return code;
    }),
    forget: vi.fn(),
  } satisfies CodeReader;
}
/** The line numbers a code view draws, once it has drawn. */
async function drawnLines(root: HTMLElement) {
  let lines: string[] = [];
  await vi.waitFor(() => {
    const shadow = root.querySelector("diffs-container")?.shadowRoot;
    lines = [...(shadow?.querySelectorAll("[data-column-number]") ?? [])].map(
      (node) => node.textContent ?? "",
    );
    expect(lines.length).toBeGreaterThan(0);
  });
  return lines;
}
const selectedLines = (root: HTMLElement) =>
  new Set(
    [
      ...(root
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelectorAll("[data-selected-line][data-line]") ??
        []),
    ].map((node) => node.getAttribute("data-line")),
  );

it("names a whole file from its link and reads it only to open the viewer", async () => {
  const code = reader();
  render(
    <CodePreview
      url={`${base}/blob/main/src/a.ts`}
      reader={code}
      comment={undefined}
    />,
  );
  const card = screen.getByRole("region", { name: "Code: src/a.ts" });
  expect(card.textContent).toContain("example-org/sample@main · typescript");
  expect(code.read).not.toHaveBeenCalled();
  fireEvent.click(within(card).getByRole("button", { name: "Open file" }));
  const dialog = await screen.findByRole("dialog", { name: "src/a.ts" });
  expect(code.read).toHaveBeenCalledTimes(1);
  expect(await drawnLines(dialog)).toHaveLength(30);
});

it("shows a range's lines with their own numbers, and the whole file in the viewer with the range marked", async () => {
  render(
    <CodePreview
      url={`${base}/blob/main/src/a.ts#L12-L14`}
      reader={reader()}
      comment={undefined}
    />,
  );
  const card = screen.getByRole("region", { name: "Code: src/a.ts" });
  expect(card.textContent).toContain("lines 12–14");
  expect(await drawnLines(card)).toEqual(["12", "13", "14"]);
  expect(
    card.querySelector("diffs-container")?.shadowRoot?.textContent,
  ).toContain("const v13 = 13;");
  fireEvent.click(within(card).getByRole("button", { name: "Open in viewer" }));
  const dialog = await screen.findByRole("dialog", { name: "src/a.ts" });
  expect(await drawnLines(dialog)).toHaveLength(30);
  await vi.waitFor(() =>
    expect(selectedLines(dialog)).toEqual(new Set(["12", "13", "14"])),
  );
});

it("says when the lines are gone, and why a file can't be read, with a way to GitHub", async () => {
  const { unmount } = render(
    <CodePreview
      url={`${base}/blob/main/src/a.ts#L99`}
      reader={reader()}
      comment={undefined}
    />,
  );
  expect(
    await screen.findByText("This file no longer has line 99."),
  ).toBeTruthy();
  unmount();
  const url = `${base}/blob/main/big.ts#L1`;
  render(
    <CodePreview
      url={url}
      reader={reader(new Error("This file is too large to show here."))}
      comment={undefined}
    />,
  );
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("This file is too large to show here.");
  expect(
    within(alert).getByRole("link", { name: "Open on GitHub" }),
  ).toHaveProperty("href", url);
});

it("posts a review comment on the chosen pull request lines only when asked, and shows GitHub's refusal", async () => {
  const path = "src/a.ts";
  const file = createHash("sha256").update(path).digest("hex");
  const code = reader({
    ref: "head1",
    path,
    text,
    pull: {
      head: "head1",
      threads: [
        {
          line: 4,
          startLine: 4,
          side: "RIGHT",
          comments: [{ author: "octo", body: "Rename this?" }],
        },
        {
          line: 20,
          startLine: 20,
          side: "RIGHT",
          comments: [{ author: "octo", body: "Elsewhere" }],
        },
      ],
    },
  });
  const comment = vi.fn<GitHubComment>(async () => ({}));
  render(
    <CodePreview
      url={`${base}/pull/7/files#diff-${file}R3-R5`}
      reader={code}
      comment={comment}
    />,
  );
  const card = screen.getByRole("region", { name: /^Code:/ });
  expect(await drawnLines(card)).toEqual(["3", "4", "5"]);
  expect(card.textContent).toContain("example-org/sample#7 · head");
  // Existing comments on these lines, not others.
  const threads = within(card).getByRole("list", {
    name: "Review comments on these lines",
  });
  expect(threads.textContent).toContain("Rename this?");
  expect(threads.textContent).not.toContain("Elsewhere");
  await vi.waitFor(() =>
    expect(selectedLines(card)).toEqual(new Set(["3", "4", "5"])),
  );
  fireEvent.click(
    within(card).getByRole("button", { name: "Comment on lines 3–5" }),
  );
  const field = await screen.findByRole("textbox", {
    name: "Comment on lines 3–5",
  });
  expect(
    screen.getByText(
      "Posts a review comment on src/a.ts to example-org/sample#7, as your GitHub account.",
    ),
  ).toBeTruthy();
  const post = screen.getByRole("button", { name: "Post comment" });
  expect(
    post.getAttribute("aria-disabled") ?? post.hasAttribute("disabled"),
  ).toBeTruthy();
  fireEvent.change(field, { target: { value: "Off by one" } });
  expect(comment).not.toHaveBeenCalled();

  comment.mockRejectedValueOnce(new Error("Validation Failed"));
  fireEvent.click(post);
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Validation Failed",
  );
  expect(
    (
      screen.getByRole("textbox", {
        name: "Comment on lines 3–5",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("Off by one");

  fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
  await vi.waitFor(() => expect(code.forget).toHaveBeenCalled());
  expect(comment).toHaveBeenLastCalledWith(
    { repository: "example-org/sample", number: 7 },
    {
      body: "Off by one",
      commit_id: "head1",
      path,
      line: 5,
      side: "RIGHT",
      start_line: 3,
      start_side: "RIGHT",
    },
  );
  // Read again, to show the new comment.
  expect(code.read).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("textbox", { name: /^Comment on/ })).toBeNull();
});
