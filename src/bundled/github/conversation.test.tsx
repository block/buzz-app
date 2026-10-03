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
  groupConversationEvents,
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

it("loads credential-free bounded sources and honors paging without following external destinations", async () => {
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
it("uses discussion creation time and omits unsafe avatars and unavailable dates", async () => {
  const fetch = vi.fn(async (_target: string) =>
    response([
      {
        id: 4,
        created_at: "bad",
        user: { login: "sample", avatar_url: "https://other.test/avatar" },
        body: null,
      },
      {
        id: 5,
        created_at: date(13),
        user: {
          login: "author",
          avatar_url: "https://avatars.githubusercontent.com/u/1",
        },
        body: "Comment",
      },
    ]),
  );
  vi.stubGlobal("fetch", fetch);
  const page = await loadConversationPage(
    url,
    "discussion",
    1,
    new AbortController().signal,
  );
  expect(fetch.mock.calls[0]?.[0]).toBe(
    "https://api.github.com/repos/sample/project/issues/1/comments?per_page=30&page=1",
  );
  expect(page.entries[0]).toMatchObject({
    createdAt: undefined,
    authorAvatar: undefined,
    body: "",
  });
  expect(page.entries[1]).toMatchObject({
    createdAt: date(13),
    authorAvatar: "https://avatars.githubusercontent.com/u/1",
    body: "Comment",
  });
});
it("orders discussion and submitted reviews chronologically with deterministic ties", () => {
  const events = conversationEvents(
    [entry(20, { createdAt: date(13) }), entry(21, { createdAt: date(14) })],
    [entry(10, { createdAt: date(14) }), entry(22, { createdAt: date(14) })],
  );
  expect(events.map((event) => event.key)).toEqual([
    "discussion-20",
    "review-10",
    "discussion-21",
    "review-22",
  ]);
});
it("omits only empty comment-only reviews while preserving summaries and bodyless decisions", () => {
  const reviews = [
    entry(10, { state: "COMMENTED", body: "" }),
    entry(11, { state: "COMMENTED", body: " \n\t " }),
    entry(12, { state: "COMMENTED", body: "Review summary" }),
    entry(13, {
      state: "COMMENTED",
      body: "![Evidence](https://raw.githubusercontent.com/sample/project/main/preview.png)",
    }),
    entry(14, { state: "APPROVED" }),
    entry(15, { state: "CHANGES_REQUESTED" }),
    entry(16, { state: "DISMISSED" }),
    entry(17, { state: "UNKNOWN" }),
  ];
  const events = conversationEvents([entry(20)], reviews);
  expect(events.map((event) => event.key)).toEqual([
    "review-12",
    "review-13",
    "review-14",
    "review-15",
    "review-16",
    "review-17",
    "discussion-20",
  ]);
  expect(reviews).toHaveLength(8);
});
it("keeps paging available when a page contains only omitted reviews", async () => {
  const fetch = vi.fn(async (target: string) => {
    if (!target.includes("/reviews?")) return response([]);
    return target.includes("page=2")
      ? response([
          {
            id: 11,
            state: "COMMENTED",
            submitted_at: date(14),
            user: { login: "summary-reviewer" },
            body: "Summary\n\n## Review details",
          },
        ])
      : response(
          [
            {
              id: 10,
              state: "COMMENTED",
              submitted_at: date(13),
              user: { login: "inline-only" },
              body: " \n ",
            },
          ],
          {
            link: '<https://api.github.com/repos/sample/project/pulls/1/reviews?per_page=30&page=2>; rel="next"',
          },
        );
  });
  vi.stubGlobal("fetch", fetch);
  render(<GitHubConversation details={details} url={url} />);
  const more = await screen.findByRole("button", { name: "Load more reviews" });
  expect(screen.queryByText("inline-only")).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(2);
  await userEvent.setup().click(more);
  await screen.findByText("Conversation loaded · oldest first");
  const review = screen.getByRole("group", { name: "Review comment" });
  expect(within(review).getByText("summary-reviewer")).toBeVisible();
  await userEvent
    .setup()
    .click(
      within(review).getByRole("button", { name: "Expand Review comment" }),
    );
  expect(screen.getByRole("heading", { name: "Review details" })).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(
    fetch.mock.calls.some(([target]) => target.includes("/pulls/1/comments")),
  ).toBe(false);
});
it("shows honest empty copy when all submitted reviews are omitted", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: string) =>
      response(
        target.includes("/reviews?")
          ? [{ id: 10, state: "COMMENTED", submitted_at: date(13), body: "" }]
          : [],
      ),
    ),
  );
  render(<GitHubConversation details={details} url={url} />);
  await screen.findByText("Conversation loaded · oldest first");
  expect(screen.getAllByRole("group")).toHaveLength(1);
  expect(
    screen.getByText("No discussion comments or review summaries to show."),
  ).toBeVisible();
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
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/some sources are incomplete/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Expand Description" }));
  expect(
    screen.getByRole("heading", { name: "Full description" }),
  ).toBeVisible();
  failReviews = false;
  await user.click(screen.getByRole("button", { name: "Retry reviews" }));
  const approval = await screen.findByRole("group", { name: "Approved" });
  expect(within(approval).queryByRole("button")).not.toBeInTheDocument();
  expect(approval).not.toHaveTextContent("loaded code threads");
  await user.click(
    screen.getByRole("button", { name: "Load more discussion" }),
  );
  await screen.findByRole("button", { name: "Retry discussion" });
  expect(
    screen
      .getAllByText("First comment")
      .find((node) => !node.closest("[aria-hidden]")),
  ).toBeVisible();
  failPageTwo = false;
  await user.click(screen.getByRole("button", { name: "Retry discussion" }));
  await waitFor(() =>
    expect(
      screen
        .getAllByText("Second comment")
        .some((node) => !node.closest("[aria-hidden]")),
    ).toBe(true),
  );
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
it("fetches only discussion and reviews, keeps summary expansion independent and bodyless reviews noninteractive", async () => {
  const fetch = vi.fn(async (target: string) =>
    response(
      target.includes("/reviews?")
        ? [
            {
              id: 10,
              state: "DISMISSED",
              submitted_at: date(14),
              user: { login: "reviewer" },
              body: "  ",
            },
            {
              id: 11,
              state: "CHANGES_REQUESTED",
              submitted_at: date(15),
              user: { login: "another-reviewer" },
              body: "Summary\n\n## Full review",
            },
          ]
        : [
            {
              id: 20,
              created_at: date(13),
              user: { login: "contributor" },
              body: "Brief\n\n## Full comment",
            },
          ],
    ),
  );
  vi.stubGlobal("fetch", fetch);
  render(<GitHubConversation details={details} url={url} />);
  await screen.findByText("Conversation loaded · oldest first");
  expect(fetch.mock.calls.map(([target]) => target).sort()).toEqual([
    "https://api.github.com/repos/sample/project/issues/1/comments?per_page=30&page=1",
    "https://api.github.com/repos/sample/project/pulls/1/reviews?per_page=30&page=1",
  ]);
  const emptyReview = screen.getByRole("group", { name: "Review dismissed" });
  expect(within(emptyReview).queryByRole("button")).not.toBeInTheDocument();
  expect(emptyReview).toHaveAttribute("data-bodyless", "true");
  expect(emptyReview).not.toHaveTextContent("No message provided");
  expect(screen.queryByText(/code threads/i)).not.toBeInTheDocument();
  const user = userEvent.setup();
  const description = screen.getByRole("button", {
    name: "Expand Description",
  });
  expect(description.querySelector("a")).toBeNull();
  await user.click(screen.getByRole("link", { name: "author" }));
  expect(description).toHaveAttribute("aria-expanded", "false");
  await user.click(screen.getByRole("button", { name: "Toggle Description" }));
  expect(description).toHaveAttribute("aria-expanded", "true");
  await user.click(description);
  expect(description).toHaveAttribute("aria-expanded", "false");
  await user.click(description);
  await user.click(screen.getByRole("button", { name: "Expand Comment" }));
  await user.click(
    screen.getByRole("button", { name: "Expand Changes requested" }),
  );
  for (const name of ["Full description", "Full comment", "Full review"])
    expect(screen.getByRole("heading", { name })).toBeVisible();
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
  await waitFor(() => expect(pending).toHaveLength(2));
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
  await waitFor(() => expect(finish).toHaveLength(2));
  expect(screen.getAllByRole("status")).toHaveLength(2);
  expect(
    screen
      .getAllByText("No description provided")
      .find((node) => !node.closest("[aria-hidden]")),
  ).toBeVisible();
  await act(async () => {
    for (const resolve of finish) resolve(response([]));
  });
  expect(
    screen.getByText("No discussion comments or review summaries to show."),
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
  expect(
    screen
      .getAllByText("First page")
      .find((node) => !node.closest("[aria-hidden]")),
  ).toBeVisible();
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

it("uses the opening avatar only, then verdict icons and shared feedback bubbles with explicit labels", async () => {
  const states = [
    "APPROVED",
    "CHANGES_REQUESTED",
    "COMMENTED",
    "DISMISSED",
    "UNKNOWN",
  ];
  const labels = [
    "Approved",
    "Changes requested",
    "Review comment",
    "Review dismissed",
    "Reviewed",
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: string) =>
      response(
        target.includes("/reviews?")
          ? states.map((state, index) => ({
              id: 10 + index,
              state,
              submitted_at: date(13 + index),
              user: { login: `reviewer-${index}` },
              body: "Review message",
            }))
          : target.includes("/issues/")
            ? [{ id: 20, user: { login: "commenter" }, body: "Discussion" }]
            : [],
      ),
    ),
  );
  const { container } = render(
    <GitHubConversation details={details} url={url} />,
  );
  await screen.findByText("Conversation loaded · oldest first");
  expect(container.querySelectorAll(".buzz-avatar")).toHaveLength(1);
  expect(
    screen
      .getByRole("group", { name: "Description" })
      .querySelector(".buzz-avatar"),
  ).not.toBeNull();
  const icons = states.map((state, index) => {
    const marker = container.querySelector(`[data-review-state="${state}"]`);
    expect(marker).not.toBeNull();
    if (!marker) throw new Error(`Missing ${state} marker`);
    const group = marker.closest<HTMLElement>('[role="group"]');
    if (!group) throw new Error(`Missing ${state} event`);
    expect(group).toHaveAttribute("aria-label", labels[index]);
    expect(
      within(group).getByText(labels[index] ?? "Reviewed"),
    ).toHaveAttribute(
      "title",
      "Submitted review event, not the PR’s current approval status",
    );
    const icon = marker.querySelector("svg");
    if (!icon) throw new Error(`Missing ${state} icon`);
    expect(icon).toHaveAttribute("aria-hidden", "true");
    return icon.innerHTML;
  });
  expect(new Set(icons.slice(0, 4)).size).toBe(4);
  expect(icons[4]).toBe(icons[2]);
  const comment = screen.getByRole("group", { name: "Comment" });
  expect(within(comment).getByText("Comment")).toBeVisible();
  expect(comment.querySelector(".buzz-avatar")).toBeNull();
  expect(comment.querySelector("svg")?.innerHTML).toBe(icons[2]);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Toggle Approved" }));
  expect(
    screen.getByRole("button", { name: "Expand Approved" }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(
    screen.getByRole("button", {
      name: "Expand Changes requested",
    }),
  ).toHaveAttribute("aria-expanded", "false");
});

it("folds only consecutive older comments, preserving decisions and the latest event", () => {
  const events = conversationEvents(
    [
      entry(1, { createdAt: date(12) }),
      entry(3, { createdAt: date(14) }),
      entry(8, { createdAt: date(19) }),
      entry(9, { createdAt: date(20) }),
    ],
    [
      entry(2, { state: "COMMENTED", body: "A review", createdAt: date(13) }),
      entry(4, { state: "APPROVED", createdAt: date(15) }),
      entry(5, { state: "CHANGES_REQUESTED", createdAt: date(16) }),
      entry(6, { state: "DISMISSED", createdAt: date(17) }),
      entry(7, { state: "UNKNOWN", createdAt: date(18) }),
    ],
  );
  const grouped = groupConversationEvents(events);
  expect(grouped.map((event) => event.kind)).toEqual([
    "comments",
    "review",
    "review",
    "review",
    "review",
    "discussion",
    "discussion",
  ]);
  expect(grouped[0]).toMatchObject({ events: events.slice(0, 3) });
  expect(grouped.at(-1)).toBe(events.at(-1));
  const comments = events.filter((event) => event.kind === "discussion");
  expect(groupConversationEvents(comments)).toEqual([
    { key: comments[0]?.key, kind: "comments", events: comments.slice(0, -1) },
    comments.at(-1),
  ]);
  expect(groupConversationEvents([])).toEqual([]);
  expect(groupConversationEvents(comments.slice(0, 1))).toEqual(
    comments.slice(0, 1),
  );
});

it("places merge at its real time rather than forcing it after post-merge comments", () => {
  const events = conversationEvents(
    [entry(1, { createdAt: date(13) }), entry(2, { createdAt: date(18) })],
    [entry(3, { state: "APPROVED", createdAt: date(14) })],
    {
      ...details,
      mergedAt: date(17),
      mergedBy: "maintainer",
      mergedByUrl: "https://github.com/maintainer",
    },
  );
  expect(events.map((event) => event.key)).toEqual([
    "discussion-1",
    "review-3",
    "merge",
    "discussion-2",
  ]);
  expect(events[2]?.message).toMatchObject({
    author: "maintainer",
    createdAt: date(17),
    authorUrl: "https://github.com/maintainer",
  });
  expect(conversationEvents([], [], details)).toEqual([]);
  expect(
    conversationEvents([entry(1)], [], { ...details, mergedAt: date(17) }).at(
      -1,
    )?.kind,
  ).toBe("merge");
});

it("expands comment runs in place without fetching and keeps approval and merge at the higher level", async () => {
  const fetch = vi.fn(async (target: string) =>
    response(
      target.includes("/reviews?")
        ? [
            {
              id: 10,
              state: "COMMENTED",
              body: "Review summary",
              user: { login: "reviewer" },
              submitted_at: date(14),
            },
            {
              id: 11,
              state: "APPROVED",
              body: "",
              user: { login: "maintainer" },
              submitted_at: date(16),
            },
          ]
        : [
            {
              id: 20,
              body: "First discussion",
              user: { login: "contributor" },
              created_at: date(13),
            },
            {
              id: 21,
              body: "Second discussion",
              user: { login: "contributor" },
              created_at: date(15),
            },
          ],
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const view = render(
    <GitHubConversation
      details={{ ...details, mergedAt: date(17), mergedBy: "maintainer" }}
      url={url}
    />,
  );
  await screen.findByText("Conversation loaded · oldest first");
  const trigger = screen.getByRole("button", {
    name: "Show 3 earlier comments",
  });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.queryByRole("group", { name: "Comment" }),
  ).not.toBeInTheDocument();
  const approval = screen.getByRole("group", { name: "Approved" });
  const merge = screen.getByRole("group", { name: "Merged" });
  expect(approval.parentElement).toBe(merge.parentElement);
  expect(merge).toHaveAttribute("data-bodyless", "true");
  expect(within(merge).queryByRole("button")).not.toBeInTheDocument();
  const user = userEvent.setup();
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(screen.getAllByRole("group", { name: "Comment" })).toHaveLength(2);
  expect(screen.getByRole("group", { name: "Review comment" })).toBeVisible();
  expect(
    screen
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label")),
  ).toEqual([
    "Description",
    "Comment",
    "Review comment",
    "Comment",
    "Approved",
    "Merged",
  ]);
  expect(fetch).toHaveBeenCalledTimes(2);
  await user.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  view.rerender(
    <GitHubConversation details={details} url={url.replace("/1", "/2")} />,
  );
  await screen.findByText("Conversation loaded · oldest first");
  expect(
    screen.getByRole("button", { name: "Show 3 earlier comments" }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.queryByRole("group", { name: "Merged" }),
  ).not.toBeInTheDocument();
});

it("retains an expanded run and source recovery while another page appends a newer comment", async () => {
  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: string) => {
      if (target.includes("/reviews?")) return response([]);
      if (target.includes("page=2"))
        return fail
          ? new Response(null, { status: 500 })
          : response([{ id: 22, body: "Newest", created_at: date(19) }]);
      return response(
        [
          { id: 20, body: "First", created_at: date(13) },
          { id: 21, body: "Second", created_at: date(14) },
        ],
        {
          link: '<https://api.github.com/repos/sample/project/issues/1/comments?per_page=30&page=2>; rel="next"',
        },
      );
    }),
  );
  render(
    <GitHubConversation
      details={{ ...details, mergedAt: date(17) }}
      url={url}
    />,
  );
  const more = await screen.findByRole("button", {
    name: "Load more discussion",
  });
  const trigger = screen.getByRole("button", {
    name: "Show 2 earlier comments",
  });
  fireEvent.click(trigger);
  fireEvent.click(more);
  const retry = await screen.findByRole("button", { name: "Retry discussion" });
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(screen.getAllByRole("group", { name: "Comment" })).toHaveLength(2);
  fail = false;
  fireEvent.click(retry);
  await screen.findByText("Conversation loaded · oldest first");
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(screen.getAllByRole("group").at(-1)).toHaveTextContent("Newest");
  expect(screen.getAllByRole("group", { name: "Comment" })).toHaveLength(3);
});
