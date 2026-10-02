// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  conversationEvents,
  loadConversationPage,
  type ConversationEntry,
} from "./conversation";
import { GitHubConversation } from "./GitHubConversation";
import type { GitHubDetails } from "./data";
const url = "https://github.com/sample/project/pull/1";
const details: GitHubDetails = {
  title: "A change",
  state: "open",
  author: "author",
  authorUrl: "https://github.com/author",
  createdAt: "2026-10-01T12:00:00Z",
  body: "Summary\n\n## Full description",
  facts: [],
};
const response = (json: unknown, headers?: HeadersInit) =>
  new Response(JSON.stringify(json), { ...(headers ? { headers } : {}) });
const date = (hour: number) => `2026-10-01T${hour}:00:00Z`;
const entry = (
  id: number,
  fields: Partial<ConversationEntry> = {},
): ConversationEntry => ({
  id,
  author: "sample",
  body: "",
  createdAt: date(12),
  ...fields,
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("loads three credential-free bounded sources and honors paging without following external destinations", async () => {
  const fetch = vi.fn(async () =>
    response(
      [
        {
          id: 1,
          user: { login: "reviewer" },
          state: "APPROVED",
          submitted_at: date(13),
          body: "",
        },
        { id: 2, state: "PENDING" },
      ],
      {
        link: '<https://api.github.com/repos/sample/project/pulls/1/reviews?per_page=30&page=2>; rel="next"',
      },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  const page = await loadConversationPage(url, "reviews", 1, signal);
  expect(page.next).toBe(2);
  expect(page.entries).toHaveLength(1);
  expect(page.entries[0]).toMatchObject({
    id: 1,
    createdAt: date(13),
    state: "APPROVED",
    body: "",
  });
  expect(fetch).toHaveBeenCalledWith(
    "https://api.github.com/repos/sample/project/pulls/1/reviews?per_page=30&page=1",
    {
      signal,
      credentials: "omit",
      headers: { Accept: "application/vnd.github.full+json" },
    },
  );
  fetch.mockImplementation(async () =>
    response([], { link: '<https://other.test/private?page=2>; rel="next"' }),
  );
  await expect(loadConversationPage(url, "reviews", 1, signal)).rejects.toThrow(
    "unexpected next-page",
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("uses created time and original line context, omits unsafe avatars and unavailable dates", async () => {
  const fetch = vi.fn(async (_target: string) =>
    response([
      {
        id: 4,
        created_at: "bad",
        user: { login: "sample", avatar_url: "https://other.test/avatar" },
        original_line: 8,
        line: null,
        path: "src/example.ts",
        in_reply_to_id: 3,
        pull_request_review_id: 10,
        diff_hunk: "@@ context",
        body: null,
      },
    ]),
  );
  vi.stubGlobal("fetch", fetch);
  const page = await loadConversationPage(
    url,
    "inline",
    1,
    new AbortController().signal,
  );
  expect(fetch.mock.calls[0]?.[0]).toBe(
    "https://api.github.com/repos/sample/project/pulls/1/comments?per_page=30&page=1&sort=created&direction=asc",
  );
  expect(page.entries[0]).toMatchObject({
    line: 8,
    replyTo: 3,
    reviewId: 10,
    diff: "@@ context",
    createdAt: undefined,
    authorAvatar: undefined,
    body: "",
  });
});
it("groups roots/replies once beneath their root review and preserves standalone missing context", () => {
  const review = entry(10, { createdAt: date(14) });
  const discussion = entry(20, { createdAt: date(13) });
  const root = entry(30, { reviewId: 10, createdAt: date(14) });
  const reply = entry(31, {
    replyTo: 30,
    reviewId: 11,
    author: "reply-author",
    createdAt: date(15),
  });
  const orphan = entry(32, { replyTo: 99, reviewId: 10 });
  const standalone = entry(40, { reviewId: 77 });
  const events = conversationEvents(
    [discussion],
    [review],
    [reply, standalone, root, orphan],
  );
  expect(events.map((event) => event.key)).toEqual([
    "thread-99",
    "thread-40",
    "discussion-20",
    "review-10",
  ]);
  expect(events.at(-1)?.threads).toEqual([
    { id: 30, root, replies: [reply], missingRoot: false },
  ]);
  expect(events[0]?.threads[0]?.missingRoot).toBe(true);
  expect(
    events.flatMap((event) =>
      event.threads.flatMap((thread) => [
        thread.root.id,
        ...thread.replies.map((comment) => comment.id),
      ]),
    ),
  ).toEqual([32, 40, 30, 31]);
});
it("keeps source failures independent, retains pages during retry and fetches more only on request", async () => {
  let failReviews = true,
    failPageTwo = true;
  const fetch = vi.fn(async (target: string) => {
    if (target.includes("/reviews?"))
      return failReviews
        ? new Response(null, { status: 403 })
        : response([
            {
              id: 10,
              state: "APPROVED",
              submitted_at: date(14),
              user: { login: "reviewer" },
              body: "",
            },
          ]);
    if (target.includes("/issues/")) {
      if (target.includes("page=2"))
        return failPageTwo
          ? new Response(null, { status: 500 })
          : response([
              { id: 20, created_at: date(13), body: "First comment" },
              { id: 21, created_at: date(15), body: "Second comment" },
            ]);
      return response(
        [{ id: 20, created_at: date(13), body: "First comment" }],
        {
          link: '<https://api.github.com/repos/sample/project/issues/1/comments?per_page=30&page=2>; rel="next"',
        },
      );
    }
    return response([]);
  });
  vi.stubGlobal("fetch", fetch);
  render(<GitHubConversation details={details} url={url} />);
  const user = userEvent.setup();
  await screen.findByRole("button", { name: "Retry reviews" });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(screen.getByText(/some sources are incomplete/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Expand Description" }));
  expect(
    screen.getByRole("heading", { name: "Full description" }),
  ).toBeVisible();
  failReviews = false;
  await user.click(screen.getByRole("button", { name: "Retry reviews" }));
  await screen.findByRole("button", { name: "Expand Approved" });
  await user.click(
    screen.getByRole("button", { name: "Load more discussion" }),
  );
  await screen.findByRole("button", { name: "Retry discussion" });
  expect(screen.getByText("First comment")).toBeVisible();
  failPageTwo = false;
  await user.click(screen.getByRole("button", { name: "Retry discussion" }));
  await screen.findByText("Second comment");
  expect(
    screen.getAllByRole("button", { name: "Expand Comment" }),
  ).toHaveLength(2);
  expect(screen.getByText("Conversation loaded · oldest first")).toBeVisible();
  expect(
    fetch.mock.calls
      .map(([target]) => target)
      .filter((target) => target.includes("/issues/")),
  ).toHaveLength(3);
});
it("expands independently with linked authors outside triggers and empty reviews with grouped replies", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: string) =>
      response(
        target.includes("/reviews?")
          ? [
              {
                id: 10,
                state: "DISMISSED",
                submitted_at: date(14),
                user: { login: "reviewer" },
                body: "",
              },
            ]
          : target.includes("/issues/")
            ? [
                {
                  id: 20,
                  created_at: date(13),
                  user: { login: "contributor" },
                  body: "Brief\n\n## Full comment",
                },
              ]
            : [
                {
                  id: 30,
                  created_at: date(14),
                  user: { login: "reviewer" },
                  path: "src/body.ts",
                  line: 7,
                  diff_hunk: "@@ diff",
                  body: "Root",
                  pull_request_review_id: 10,
                },
                {
                  id: 31,
                  in_reply_to_id: 30,
                  user: { login: "reply-author" },
                  created_at: date(15),
                  body: "Reply",
                  pull_request_review_id: 11,
                },
              ],
      ),
    ),
  );
  render(<GitHubConversation details={details} url={url} />);
  const user = userEvent.setup();
  const review = await screen.findByRole("button", {
    name: "Expand Review dismissed",
  });
  expect(review).toHaveTextContent("1 loaded code threads");
  const description = screen.getByRole("button", {
    name: "Expand Description",
  });
  expect(description.querySelector("a")).toBeNull();
  const profile = screen.getByRole("link", { name: "author" });
  await user.click(profile);
  expect(description).toHaveAttribute("aria-expanded", "false");
  await user.click(screen.getByRole("button", { name: "Toggle Description" }));
  expect(description).toHaveAttribute("aria-expanded", "true");
  await user.click(description);
  expect(description).toHaveAttribute("aria-expanded", "false");
  await user.click(description);
  await user.click(screen.getByRole("button", { name: "Expand Comment" }));
  expect(
    screen.getByRole("heading", { name: "Full description" }),
  ).toBeVisible();
  expect(screen.getByRole("heading", { name: "Full comment" })).toBeVisible();
  await user.click(review);
  await user.click(
    screen.getByRole("button", { name: "src/body.ts:7 · 2 loaded comments" }),
  );
  expect(screen.getByText("@@ diff")).toBeVisible();
  const replyButton = screen.getByRole("button", {
    name: "Expand Code comment by reply-author",
  });
  expect(replyButton.parentElement?.querySelector("time")).toHaveAttribute(
    "datetime",
    date(15),
  );
  expect(screen.getAllByText("Root")).toHaveLength(1);
});
it("aborts all old sources, ignores late results and resets pages and expansion on PR changes", async () => {
  const pending: { resolve(response: Response): void; signal: AbortSignal }[] =
    [];
  vi.stubGlobal(
    "fetch",
    vi.fn((target: string, options: RequestInit) =>
      target.includes("/2/")
        ? Promise.resolve(response([]))
        : new Promise<Response>((resolve) =>
            pending.push({ resolve, signal: options.signal as AbortSignal }),
          ),
    ),
  );
  const view = render(<GitHubConversation details={details} url={url} />);
  await waitFor(() => expect(pending).toHaveLength(3));
  fireEvent.click(screen.getByRole("button", { name: "Expand Description" }));
  view.rerender(
    <GitHubConversation
      details={{ ...details, body: "New summary\n\n## New body" }}
      url={url.replace("/1", "/2")}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByText("Conversation loaded · oldest first"),
    ).toBeVisible(),
  );
  expect(pending.every(({ signal }) => signal.aborted)).toBe(true);
  await act(async () => {
    for (const request of pending)
      request.resolve(response([{ id: 20, body: "Stale comment" }]));
  });
  expect(screen.queryByText("Stale comment")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Expand Description" }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.queryByRole("heading", { name: "Full description" }),
  ).not.toBeInTheDocument();
});
it("keeps description usable while held sources load and gives neutral empty copy after completion", async () => {
  const finish: ((response: Response) => void)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>((resolve) => finish.push(resolve))),
  );
  render(<GitHubConversation details={{ ...details, body: "" }} url={url} />);
  await waitFor(() => expect(finish).toHaveLength(3));
  expect(screen.getAllByRole("status")).toHaveLength(3);
  expect(screen.getByText("No description provided")).toBeVisible();
  await act(async () => {
    for (const resolve of finish) resolve(response([]));
  });
  expect(
    screen.getByText("No comments or submitted reviews yet."),
  ).toBeVisible();
  expect(
    screen.queryByRole("region", { name: "Discussion" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("All pages loaded")).not.toBeInTheDocument();
  expect(screen.getByText("Conversation loaded · oldest first")).toBeVisible();
});

it("keeps more-page loading explicit and ignores late page results after switching PRs", async () => {
  let finish!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  let started = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((target: string, options: RequestInit) => {
      if (target.includes("page=2")) {
        started = true;
        signal = options.signal as AbortSignal;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      return Promise.resolve(
        response(
          target.includes("/issues/1/") ? [{ id: 20, body: "First page" }] : [],
          target.includes("/issues/1/")
            ? {
                link: '<https://api.github.com/repos/sample/project/issues/1/comments?per_page=30&page=2>; rel="next"',
              }
            : undefined,
        ),
      );
    }),
  );
  const view = render(<GitHubConversation details={details} url={url} />);
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: "Load more discussion" }));
  await waitFor(() => expect(started).toBe(true));
  const source = screen.getByRole("region", { name: "Discussion" });
  expect(within(source).getByRole("status")).toHaveTextContent(
    "Loading discussion",
  );
  expect(within(source).queryByRole("button")).not.toBeInTheDocument();
  expect(screen.getByText("First page")).toBeVisible();
  view.rerender(
    <GitHubConversation details={details} url={url.replace("/1", "/2")} />,
  );
  await waitFor(() =>
    expect(
      screen.getByText("Conversation loaded · oldest first"),
    ).toBeVisible(),
  );
  expect(signal?.aborted).toBe(true);
  await act(async () => finish(response([{ id: 21, body: "Stale page two" }])));
  expect(screen.queryByText("Stale page two")).not.toBeInTheDocument();
  expect(screen.queryByText("First page")).not.toBeInTheDocument();
});
