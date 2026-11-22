// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { useEffect } from "react";
import type { DiffComments } from "../diffs/DiffViewer";
import { PrFiles } from "./PrFiles";
import { createInlineDelivery } from "./inline-delivery";
import { createPanelMemory } from "./panel-memory";
import {
  createPrComments,
  type Comment,
  type Thread,
  type CommentPage,
} from "./pr-comments";
import {
  fixturePull,
  githubCommentHost,
} from "../../../tests/fixtures/github-comment-host";

vi.stubGlobal("crypto", webcrypto);
afterAll(() => vi.unstubAllGlobals());
afterEach(cleanup);

const diffRender = vi.hoisted(() => vi.fn());
const commentRender = vi.hoisted(() => vi.fn());
vi.mock("./GitHubComment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./GitHubComment")>();
  return {
    ...actual,
    GitHubComment: (props: Parameters<typeof actual.GitHubComment>[0]) => {
      commentRender();
      return <actual.GitHubComment {...props} />;
    },
  };
});

// Exercise panel ownership while the browser suite covers Pierre's portals.
vi.mock("../diffs/DiffViewer", () => ({
  DiffViewer: ({ comments }: { comments?: DiffComments }) => {
    diffRender();
    useEffect(() => {
      comments?.onAvailabilityChange?.("src/example.ts", true);
      return () => comments?.onAvailabilityChange?.("src/example.ts", false);
    }, [comments?.onAvailabilityChange]);
    return (
      <>
        <button
          type="button"
          onClick={() =>
            comments?.onSelect(
              "src/example.ts",
              [{ side: "additions", lineNumber: 5001 }],
              () => {},
            )
          }
        >
          Select line
        </button>
        <button
          type="button"
          onClick={() =>
            comments?.onSelect(
              "src/example.ts",
              [{ side: "deletions", lineNumber: 5000 }],
              () => {},
            )
          }
        >
          Select other line
        </button>
        {comments?.annotations.map((annotation) => (
          <div key={`${annotation.side}:${annotation.lineNumber}`}>
            {annotation.content}
          </div>
        ))}
      </>
    );
  },
}));

it("discards a reply page that completes after a new snapshot replaces its owner", async () => {
  const fixture = githubCommentHost();
  const transport = createPrComments(fixture.host);
  if (!transport) throw new Error("Missing adapter");
  const snapshot = await transport.loadSnapshot(fixturePull);
  const comment: Comment = {
    id: "first",
    databaseId: 1,
    body: "First page",
    author: "reviewer",
    url: "https://github.com/example-org/sample/pull/1#discussion_r1",
  };
  const thread: Thread = {
    id: "thread",
    path: "src/example.ts",
    side: "RIGHT",
    line: 5001,
    originalLine: 5001,
    outdated: false,
    resolved: false,
    rootCommentId: 1,
    comments: [comment],
    commentsComplete: false,
    commentsCursor: "page-2",
  };
  let release!: (value: CommentPage) => void;
  const page = new Promise<CommentPage>((resolve) => {
    release = resolve;
  });
  const loadSnapshot = vi.fn().mockResolvedValue(snapshot);
  const loadComments = vi.fn().mockReturnValue(page);
  const api = {
    ...transport,
    loadSnapshot,
    loadComments,
    loadThreads: vi.fn().mockResolvedValue({
      items: [thread],
      head: snapshot.head,
      base: snapshot.base,
      nextCursor: null,
    }),
  };
  render(
    <PrFiles
      api={api}
      pull={fixturePull}
      head={snapshot.head}
      base={snapshot.base}
      delivery={createInlineDelivery()}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Load more replies" }),
  );
  expect(loadComments).toHaveBeenCalledWith("thread", "page-2");
  // A refresh gets a distinct verified object even when the refs did not move.
  loadSnapshot.mockResolvedValue({ ...snapshot });
  fireEvent.click(screen.getByRole("button", { name: "Refresh changes" }));
  await screen.findByText("First page");
  await act(async () => {
    release({
      items: [{ ...comment, id: "late", body: "Late old page" }],
      nextCursor: null,
      thread,
      pullId: snapshot.pullId,
      head: snapshot.head,
      base: snapshot.base,
    });
  });
  expect(screen.queryByText("Late old page")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Load more replies" }),
  ).toBeTruthy();
});

it("loads all three reply pages without confusing ownership with pagination", async () => {
  const fixture = githubCommentHost();
  const api = createPrComments(fixture.host);
  if (!api) throw new Error("Missing adapter");
  const snapshot = await api.loadSnapshot(fixturePull);
  const loadThreads = vi.spyOn(api, "loadThreads");
  await api.create(
    snapshot,
    { ...snapshot, path: "src/example.ts", side: "RIGHT", line: 5001 },
    "Comment 1",
    "seed",
  );
  const root = fixture.state.comments[0];
  if (!root) throw new Error("Missing root");
  for (let id = 2; id <= 201; id++)
    fixture.state.comments.push({
      ...root,
      id,
      node_id: `comment-${id}`,
      body: `Comment ${id}`,
      in_reply_to_id: root.id,
    });
  render(
    <PrFiles
      api={api}
      pull={fixturePull}
      head={snapshot.head}
      base={snapshot.base}
      delivery={createInlineDelivery()}
    />,
  );
  const firstMore = (await screen.findByText("Load more replies")).closest(
    "button",
  );
  if (!firstMore) throw new Error("Missing pagination button");
  fireEvent.click(firstMore);
  await screen.findByText("Comment 200");
  const lastMore = screen.getByText("Load more replies").closest("button");
  if (!lastMore) throw new Error("Missing pagination button");
  fireEvent.click(lastMore);
  await screen.findByText("Comment 201");
  expect(lastMore.isConnected).toBe(false);
  expect(screen.queryByText("Load more replies")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Comment 1")).toBeTruthy();
  expect(loadThreads).toHaveBeenCalledTimes(1);
});

it.each([
  "pullId",
  "head",
  "base",
  "id",
  "path",
  "side",
  "rootCommentId",
  "line",
  "outdated",
] as const)("rejects a reply page when %s ownership changes", async (field) => {
  const fixture = githubCommentHost();
  const transport = createPrComments(fixture.host);
  if (!transport) throw new Error("Missing adapter");
  const snapshot = await transport.loadSnapshot(fixturePull);
  await transport.create(
    snapshot,
    { ...snapshot, path: "src/example.ts", side: "RIGHT", line: 5001 },
    "Comment 1",
    "seed",
  );
  await transport.reply(snapshot, 1, "Late reply", "seed-reply");
  fixture.state.pageSize = 1;
  const loadThreads = vi.spyOn(transport, "loadThreads");
  const api = {
    ...transport,
    async loadComments(...args: Parameters<typeof transport.loadComments>) {
      const page = await transport.loadComments(...args);
      if (field === "pullId" || field === "head" || field === "base")
        return { ...page, [field]: "changed" };
      return {
        ...page,
        thread: {
          ...page.thread,
          [field]:
            field === "line" || field === "rootCommentId"
              ? 99
              : field === "outdated"
                ? true
                : field === "side"
                  ? "LEFT"
                  : "changed",
        },
      } as CommentPage;
    },
  };
  render(
    <PrFiles
      api={api}
      pull={fixturePull}
      head={snapshot.head}
      base={snapshot.base}
      delivery={createInlineDelivery()}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Load more replies" }),
  );
  await screen.findByText("Thread changed; refresh changes.");
  expect(screen.queryByText("Late reply")).toBeNull();
  expect(loadThreads).toHaveBeenCalledTimes(1);
});

async function setupComposer() {
  const fixture = githubCommentHost();
  const api = createPrComments(fixture.host);
  if (!api) throw new Error("Missing adapter");
  const snapshot = await api.loadSnapshot(fixturePull);
  await api.create(
    snapshot,
    { ...snapshot, path: "src/example.ts", side: "RIGHT", line: 5001 },
    "Existing thread",
    "seed",
  );
  const delivery = createInlineDelivery();
  const panel = () => (
    <PrFiles
      api={api}
      pull={fixturePull}
      head={snapshot.head}
      base={snapshot.base}
      delivery={delivery}
    />
  );
  const open = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    return screen.getByRole("textbox", { name: "Comment" });
  };
  return { ...fixture, panel, open, delivery };
}
it("edits a comment without updating the diff and submits the current text", async () => {
  const { panel, open, state } = await setupComposer();
  render(panel());
  const input = await open();
  const renders = diffRender.mock.calls.length;
  const calls = state.calls.length;
  for (const value of ["a", "ab", "abc"])
    fireEvent.change(input, { target: { value } });
  expect(input).toHaveProperty("value", "abc");
  expect(diffRender.mock.calls.length).toBe(renders);
  expect(state.calls).toHaveLength(calls);
  fireEvent.click(screen.getByRole("button", { name: "Post to GitHub" }));
  await screen.findByRole("link", { name: "View on GitHub" });
  expect(state.comments.at(-1)?.body).toBe("abc");
});

it("opens and cancels an editor without rendering existing comments again", async () => {
  const { panel, open } = await setupComposer();
  render(panel());
  await screen.findByText("Existing thread");
  const renders = commentRender.mock.calls.length;
  await open();
  expect(commentRender.mock.calls.length).toBe(renders);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(commentRender.mock.calls.length).toBe(renders);
});

it.each(["Cancel", "Escape", "refresh", "unmount"])(
  "discards unsent text on %s and reopens empty",
  async (action) => {
    const { panel, open } = await setupComposer();
    let view = render(panel());
    const input = await open();
    fireEvent.change(input, { target: { value: "Disposable text" } });
    if (action === "Cancel")
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    else if (action === "Escape") fireEvent.keyDown(input, { key: "Escape" });
    else if (action === "refresh")
      fireEvent.click(screen.getByRole("button", { name: "Refresh changes" }));
    else {
      view.unmount();
      view = render(panel());
    }
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(await open()).toHaveProperty("value", "");
  },
);
it("keeps an in-flight lock and unknown receipt after cancel and remount", async () => {
  const { panel, open, state, delivery } = await setupComposer();
  state.mode = "hold";
  const view = render(panel());
  const input = await open();
  fireEvent.change(input, { target: { value: "Submitted once" } });
  const form = input.closest("form");
  if (!form) throw new Error("Missing composer");
  fireEvent.submit(form);
  await waitFor(() => expect(state.release).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  view.unmount();
  render(panel());
  expect(screen.queryByRole("textbox")).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Reply" })).toHaveProperty(
      "disabled",
      true,
    ),
  );
  state.mode = "timeout";
  await act(async () => {
    state.release?.();
  });
  await screen.findByRole("button", { name: "Check delivery" });
  expect(delivery.get().unknown).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Check delivery" }));
  await screen.findByRole("link", { name: "View on GitHub" });
  expect(state.calls.filter((call) => call.args[0] === "POST")).toHaveLength(2); // seed + one submission
  expect(delivery.get().unknown).toBe(false);
});

it("admits only one submission across two panels and duplicate gestures", async () => {
  const fixture = githubCommentHost();
  const api = createPrComments(fixture.host);
  if (!api) throw new Error("Missing adapter");
  const snapshot = await api.loadSnapshot(fixturePull);
  await api.create(
    snapshot,
    { ...snapshot, path: "src/example.ts", side: "RIGHT", line: 5001 },
    "Existing thread",
    "seed",
  );
  const memory = createPanelMemory();
  const views = [
    "https://github.com/Example-org/Sample/pull/1",
    "https://github.com/example-org/sample/pull/1",
  ].map((url) =>
    render(
      <PrFiles
        api={api}
        pull={fixturePull}
        head={snapshot.head}
        base={snapshot.base}
        delivery={memory.delivery(url)}
      />,
    ),
  );
  const forms: HTMLFormElement[] = [];
  for (const view of views) {
    const panel = within(view.container);
    fireEvent.click(await panel.findByRole("button", { name: "Reply" }));
    const input = panel.getByRole("textbox", { name: "Comment" });
    fireEvent.change(input, { target: { value: "Same" } });
    const form = input.closest("form");
    if (!form) throw new Error("Missing composer");
    forms.push(form);
  }
  fixture.state.mode = "hold";
  for (const form of forms) {
    fireEvent.submit(form);
    fireEvent.submit(form);
  }
  await waitFor(() =>
    expect(
      fixture.state.calls.filter((call) => call.args[0] === "POST"),
    ).toHaveLength(2),
  );
  await act(async () => {
    fixture.state.release();
  });
  await waitFor(() =>
    expect(
      memory.delivery("https://github.com/example-org/sample/pull/1").get()
        .busy,
    ).toBe(false),
  );
  expect(
    fixture.state.comments.filter((row) => row.body === "Same"),
  ).toHaveLength(1);
});

it("opens a composer before the pending thread read finishes", async () => {
  const fixture = githubCommentHost();
  const transport = createPrComments(fixture.host);
  if (!transport) throw new Error("Missing adapter");
  const snapshot = await transport.loadSnapshot(fixturePull);
  let release!: (value: {
    items: Thread[];
    head: string;
    base: string;
    nextCursor: null;
  }) => void;
  const pending = new Promise<{
    items: Thread[];
    head: string;
    base: string;
    nextCursor: null;
  }>((resolve) => {
    release = resolve;
  });
  const api = { ...transport, loadThreads: vi.fn().mockReturnValue(pending) };
  render(
    <PrFiles
      api={api}
      pull={fixturePull}
      head={snapshot.head}
      base={snapshot.base}
      delivery={createInlineDelivery()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Select line" }));
  expect(screen.getByRole("textbox", { name: "Comment" })).toBeTruthy();
  expect(screen.queryByText(/Posting as/)).toBeNull();
  await act(async () =>
    release({
      items: [],
      head: snapshot.head,
      base: snapshot.base,
      nextCursor: null,
    }),
  );
});

it("keeps a reconciled thread when the older initial read completes later", async () => {
  const fixture = githubCommentHost();
  const transport = createPrComments(fixture.host);
  if (!transport) throw new Error("Missing adapter");
  const snapshot = await transport.loadSnapshot(fixturePull);
  const sent = await transport.create(
    snapshot,
    {
      ...snapshot,
      path: "src/example.ts",
      side: "RIGHT",
      line: 5001,
    },
    "Confirmed while loading",
    "seed",
  );
  if (sent.status !== "sent") throw new Error("Expected receipt");
  const empty = {
    items: [],
    head: snapshot.head,
    base: snapshot.base,
    nextCursor: null,
  };
  let release!: (value: typeof empty) => void;
  const pending = new Promise<typeof empty>((resolve) => {
    release = resolve;
  });
  const loadThreads = vi
    .fn()
    .mockReturnValueOnce(pending)
    .mockImplementation(transport.loadThreads);
  const api = {
    ...transport,
    loadThreads,
    reconcile: vi.fn().mockResolvedValue(sent),
  };
  const delivery = createInlineDelivery();
  delivery.update({ unknown: true, attempt: "uncertain" });
  render(
    <PrFiles
      api={api}
      pull={fixturePull}
      head={snapshot.head}
      base={snapshot.base}
      delivery={delivery}
    />,
  );
  await waitFor(() => expect(loadThreads).toHaveBeenCalledOnce());
  try {
    fireEvent.click(screen.getByRole("button", { name: "Check delivery" }));
    await screen.findByText("Confirmed while loading");
  } finally {
    await act(async () => release(empty));
  }
  expect(screen.getByText("Confirmed while loading")).toBeTruthy();
});

it.each(["success", "timeout"] as const)(
  "isolates a reply and a new composer through %s delivery",
  async (mode) => {
    const { panel, open, state } = await setupComposer();
    render(panel());
    const reply = await open();
    fireEvent.change(reply, { target: { value: "Reply to send" } });
    fireEvent.click(screen.getByRole("button", { name: "Select other line" }));
    const other = screen
      .getAllByRole("textbox")
      .find((input) => input !== reply);
    if (!other) throw new Error("Missing second composer");
    fireEvent.change(other, { target: { value: "Keep the other comment" } });
    state.mode = mode;
    const replyForm = reply.closest("form");
    if (!replyForm) throw new Error("Missing reply form");
    fireEvent.submit(replyForm);
    if (mode === "timeout") {
      await screen.findByRole("button", { name: "Check delivery" });
      const independent = other.closest("form");
      if (!independent) throw new Error("Missing independent form");
      fireEvent.submit(independent);
      expect(
        state.calls.filter((call) => call.args[0] === "POST"),
      ).toHaveLength(2);
      fireEvent.click(
        await screen.findByRole("button", { name: "Check delivery" }),
      );
    }
    await waitFor(() => expect(reply.isConnected).toBe(false));
    expect(other).toHaveProperty("value", "Keep the other comment");
    expect(state.comments.map((comment) => comment.body)).toEqual([
      "Existing thread",
      "Reply to send",
    ]);
    const otherForm = other.closest("form");
    if (!otherForm) throw new Error("Missing independent form");
    state.mode = "success";
    fireEvent.submit(otherForm);
    await screen.findByText("Keep the other comment");
    expect(state.calls.filter((call) => call.args[0] === "POST")).toHaveLength(
      3,
    );
  },
);

it("discards composers on tab leave while retaining its verified snapshot", async () => {
  const { panel, open, state } = await setupComposer();
  const view = render(panel());
  const input = await open();
  fireEvent.change(input, { target: { value: "Discard on leave" } });
  const reads = state.calls.length;
  view.rerender(<PrFiles {...panel().props} active={false} />);
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  view.rerender(<PrFiles {...panel().props} active />);
  expect(state.calls).toHaveLength(reads);
  await open();
  expect(screen.getByRole("textbox")).toHaveProperty("value", "");
});
