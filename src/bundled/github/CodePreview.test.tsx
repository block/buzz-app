// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Code, CodeReader } from "./code";
import { CodeExcerpt, CodeLinkLabel, CodePanel } from "./CodePreview";
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

const excerpt = (
  url: string,
  code: CodeReader,
  comment: GitHubComment | undefined = undefined,
  open = vi.fn(() => true),
  opener = { canOpen: () => true, open: vi.fn(() => true) },
) =>
  render(
    <CodeExcerpt
      url={url}
      messageId="m"
      open={open}
      opener={opener}
      reader={code}
      comment={comment}
    />,
  );

it("names a file link by its file and lines, and draws nothing for a whole file", () => {
  const label = render(
    <CodeLinkLabel url={`${base}/blob/feature/x/src/a.ts#L12-L14`} />,
  );
  expect(label.container.textContent).toBe("a.ts:12–14");
  label.unmount();
  const code = reader();
  const { container } = excerpt(`${base}/blob/main/src/a.ts`, code);
  expect(container.textContent).toBe("");
  expect(code.read).not.toHaveBeenCalled();
});

it("shows a range's lines with their own numbers, and opens the file from the message", async () => {
  const open = vi.fn(() => true);
  const { container } = excerpt(
    `${base}/blob/main/src/a.ts#L12-L14`,
    reader(),
    undefined,
    open,
  );
  expect(await drawnLines(container)).toEqual(["12", "13", "14"]);
  expect(
    container.querySelector("diffs-container")?.shadowRoot?.textContent,
  ).toContain("const v13 = 13;");
  fireEvent.click(screen.getByRole("button", { name: "Open file" }));
  expect(open).toHaveBeenCalledTimes(1);
});

it("shows the whole file in the panel with the linked lines marked", async () => {
  const { container } = render(
    <CodePanel
      target={`${base}/blob/main/src/a.ts#L12-L14`}
      close={() => {}}
      reader={reader()}
    />,
  );
  expect(await drawnLines(container)).toHaveLength(30);
  await vi.waitFor(() =>
    expect(selectedLines(container)).toEqual(new Set(["12", "13", "14"])),
  );
  expect(screen.getByTitle("Branch main")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "Open on GitHub" }).getAttribute("href"),
  ).toBe(`${base}/blob/main/src/a.ts#L12-L14`);
});

it("says when the lines are gone, or why a file can't be read", async () => {
  const { unmount } = excerpt(`${base}/blob/main/src/a.ts#L99`, reader());
  expect(
    await screen.findByText("This file no longer has line 99."),
  ).toBeTruthy();
  unmount();
  excerpt(
    `${base}/blob/main/big.ts#L1`,
    reader(new Error("This file is too large to show here.")),
  );
  expect(
    await screen.findByText(
      "Can’t show these lines: This file is too large to show here.",
    ),
  ).toBeTruthy();
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
      branch: "feature",
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
  const opener = { canOpen: () => true, open: vi.fn(() => true) };
  const { container } = excerpt(
    `${base}/pull/7/files#diff-${file}R3-R5`,
    code,
    comment,
    undefined,
    opener,
  );
  expect(await drawnLines(container)).toEqual(["3", "4", "5"]);
  expect(screen.getByTitle(path)).toBeTruthy();
  expect(screen.getByTitle("Branch feature")).toBeTruthy();
  // Existing comments on these lines, not others.
  const threads = screen.getByRole("list", {
    name: "Review comments on these lines",
  });
  expect(threads.textContent).toContain("Rename this?");
  expect(threads.textContent).not.toContain("Elsewhere");
  // The file opens at the commit shown.
  fireEvent.click(screen.getByRole("button", { name: "Open file" }));
  expect(opener.open).toHaveBeenCalledWith(`${base}/blob/head1/src/a.ts#L3-L5`);
  await vi.waitFor(() =>
    expect(selectedLines(container)).toEqual(new Set(["3", "4", "5"])),
  );
  fireEvent.click(screen.getByRole("button", { name: "Comment on lines 3–5" }));
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
