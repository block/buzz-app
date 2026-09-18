// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPullRequestDetailView } from "./PullRequestDetailView";
import { createFakeRelay, createFakeSession } from "./testRelayFixtures";
import type { ChannelMessage } from "./relayTypes";
import type { PullRequestSummary } from "./types";

const pullRequest: PullRequestSummary = {
  url: "https://github.com/example/repo/pull/1",
  number: 1,
  repository: "example/repo",
  title: "Fix bug",
  author: "octocat",
  isDraft: false,
  labels: [],
  updatedAt: "2026-01-01T00:00:00Z",
  reviewDecision: null,
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body));
}

function stubGithubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        url.includes("/compare/")
          ? jsonResponse({
              files: [
                {
                  filename: "a.ts",
                  status: "modified",
                  additions: 1,
                  deletions: 1,
                  patch: "@@ -1 +1 @@\n-a\n+b",
                },
              ],
            })
          : jsonResponse({
              html_url: pullRequest.url,
              number: pullRequest.number,
              title: pullRequest.title,
              body: "",
              user: { login: pullRequest.author },
              head: { sha: "head-sha", ref: "feature" },
              base: { ref: "main", sha: "base-sha" },
            }),
      ),
    ),
  );
}

function message(overrides: Partial<ChannelMessage>): ChannelMessage {
  return {
    id: "reply-1",
    channelId: "channel-1",
    authorId: "agent-pubkey",
    createdAt: 0,
    content: "Summary text",
    mentions: [],
    attachments: [],
    reactions: [],
    participants: [],
    ...overrides,
  } as ChannelMessage;
}

function createFakeThreadReader() {
  let snapshot = {
    status: "ready" as const,
    root: undefined,
    replies: [] as ChannelMessage[],
    error: undefined,
    canLoadMore: false,
    limited: false,
  };
  const listeners = new Set<() => void>();
  let disposed = false;
  const api = {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: async () => {},
    loadMore: async () => {},
    dispose: () => {
      disposed = true;
    },
  };
  return {
    api,
    setReplies(replies: ChannelMessage[]) {
      snapshot = { ...snapshot, replies };
      for (const listener of listeners) listener();
    },
    isDisposed: () => disposed,
  };
}

const PullRequestDetailView = createPullRequestDetailView(React as never);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PullRequestDetailView agent summary", () => {
  it("sends the diff, correlates the reply to the sent event, and displays only that agent's reply", async () => {
    stubGithubFetch();
    const threadReader = createFakeThreadReader();
    const threadCalls: Array<[string, string]> = [];
    const send = vi.fn(
      (_channelId: string, _content: string, _mentions?: readonly string[]) =>
        "event-123",
    );
    const thread = vi.fn((channelId: string, messageId: string) => {
      threadCalls.push([channelId, messageId]);
      return threadReader.api;
    });
    const session = createFakeSession({
      identities: [{ pubkey: "agent-pubkey", name: "Review Bot" }],
      channels: [
        { id: "channel-1", name: "eng-reviews", members: ["agent-pubkey"] },
      ],
      send,
      thread,
    });
    const relay = createFakeRelay({ session });

    render(
      <PullRequestDetailView
        token="test-token"
        pullRequest={pullRequest}
        relay={relay}
        relaySnapshot={relay.snapshot()}
        summarySelection={{
          agentPubkey: "agent-pubkey",
          channelId: "channel-1",
        }}
      />,
    );

    const sendButton = await screen.findByRole("button", {
      name: "Send diff to agent",
    });
    await act(async () => {
      await userEvent.click(sendButton);
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("channel-1");
    expect(send.mock.calls[0][2]).toEqual(["agent-pubkey"]);
    // The thread reader must be opened against the exact event id send()
    // returned, not a guessed or reconstructed id.
    expect(threadCalls).toEqual([["channel-1", "event-123"]]);

    await act(async () => {
      threadReader.setReplies([
        message({
          id: "from-someone-else",
          authorId: "someone-else",
          content: "not it",
        }),
        message({
          id: "from-agent",
          authorId: "agent-pubkey",
          content: "Here is the summary.",
        }),
      ]);
    });

    expect(await screen.findByText("Here is the summary.")).toBeInTheDocument();
    expect(screen.queryByText("not it")).not.toBeInTheDocument();
  });

  it("blocks sending when the selected agent is not a confirmed member of the selected channel", async () => {
    stubGithubFetch();
    const send = vi.fn(() => "event-should-not-be-called");
    const session = createFakeSession({
      identities: [{ pubkey: "agent-pubkey", name: "Review Bot" }],
      channels: [
        { id: "channel-1", name: "eng-reviews", members: ["someone-else"] },
      ],
      send,
    });
    const relay = createFakeRelay({ session });

    render(
      <PullRequestDetailView
        token="test-token"
        pullRequest={pullRequest}
        relay={relay}
        relaySnapshot={relay.snapshot()}
        summarySelection={{
          agentPubkey: "agent-pubkey",
          channelId: "channel-1",
        }}
      />,
    );

    const sendButton = await screen.findByRole("button", {
      name: "Send diff to agent",
    });
    await act(async () => {
      await userEvent.click(sendButton);
    });

    expect(send).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/no longer a member of the selected channel/i),
    ).toBeInTheDocument();
  });

  it("disposes the thread reader on unmount without sending a second message", async () => {
    stubGithubFetch();
    const threadReader = createFakeThreadReader();
    const send = vi.fn(() => "event-123");
    const thread = vi.fn(() => threadReader.api);
    const session = createFakeSession({
      identities: [{ pubkey: "agent-pubkey", name: "Review Bot" }],
      channels: [
        { id: "channel-1", name: "eng-reviews", members: ["agent-pubkey"] },
      ],
      send,
      thread,
    });
    const relay = createFakeRelay({ session });

    const { unmount } = render(
      <PullRequestDetailView
        token="test-token"
        pullRequest={pullRequest}
        relay={relay}
        relaySnapshot={relay.snapshot()}
        summarySelection={{
          agentPubkey: "agent-pubkey",
          channelId: "channel-1",
        }}
      />,
    );

    const sendButton = await screen.findByRole("button", {
      name: "Send diff to agent",
    });
    await act(async () => {
      await userEvent.click(sendButton);
    });
    expect(send).toHaveBeenCalledTimes(1);

    unmount();
    expect(threadReader.isDisposed()).toBe(true);

    // A reply arriving after unmount must not trigger a second send or throw.
    threadReader.setReplies([message({ authorId: "agent-pubkey" })]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("disposes the thread watch and resets to idle when the selection changes", async () => {
    stubGithubFetch();
    const threadReader = createFakeThreadReader();
    const session = createFakeSession({
      identities: [{ pubkey: "agent-pubkey", name: "Review Bot" }],
      channels: [
        { id: "channel-1", name: "eng-reviews", members: ["agent-pubkey"] },
      ],
      send: () => "event-123",
      thread: () => threadReader.api,
    });
    const relay = createFakeRelay({ session });

    const { rerender } = render(
      <PullRequestDetailView
        token="test-token"
        pullRequest={pullRequest}
        relay={relay}
        relaySnapshot={relay.snapshot()}
        summarySelection={{
          agentPubkey: "agent-pubkey",
          channelId: "channel-1",
        }}
      />,
    );

    const sendButton = await screen.findByRole("button", {
      name: "Send diff to agent",
    });
    await act(async () => {
      await userEvent.click(sendButton);
    });
    expect(threadReader.isDisposed()).toBe(false);

    rerender(
      <PullRequestDetailView
        token="test-token"
        pullRequest={pullRequest}
        relay={relay}
        relaySnapshot={relay.snapshot()}
        summarySelection={null}
      />,
    );

    expect(threadReader.isDisposed()).toBe(true);
    expect(
      screen.getByText(/Pick a summary agent and channel in Settings/i),
    ).toBeInTheDocument();
  });

  it("keeps the watch alive across multiple replies and always shows the latest one", async () => {
    stubGithubFetch();
    const threadReader = createFakeThreadReader();
    const thread = vi.fn(() => threadReader.api);
    const session = createFakeSession({
      identities: [{ pubkey: "agent-pubkey", name: "Review Bot" }],
      channels: [
        { id: "channel-1", name: "eng-reviews", members: ["agent-pubkey"] },
      ],
      send: () => "event-123",
      thread,
    });
    const relay = createFakeRelay({ session });

    render(
      <PullRequestDetailView
        token="test-token"
        pullRequest={pullRequest}
        relay={relay}
        relaySnapshot={relay.snapshot()}
        summarySelection={{
          agentPubkey: "agent-pubkey",
          channelId: "channel-1",
        }}
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Send diff to agent" }),
    );

    await act(async () => {
      threadReader.setReplies([
        message({ id: "reply-1", content: "Working on it..." }),
      ]);
    });
    expect(await screen.findByText("Working on it...")).toBeInTheDocument();
    // Only one watch/thread was ever opened — a reply does not tear it down
    // and start a new one.
    expect(thread).toHaveBeenCalledTimes(1);
    expect(threadReader.isDisposed()).toBe(false);

    await act(async () => {
      threadReader.setReplies([
        message({ id: "reply-1", content: "Working on it..." }),
        message({ id: "reply-2", content: "Here is the final summary." }),
      ]);
    });
    expect(
      await screen.findByText("Here is the final summary."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Working on it...")).not.toBeInTheDocument();
    expect(thread).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale refresh callback from a watch that was superseded by a relay generation change", async () => {
    stubGithubFetch();
    const threadReader = createFakeThreadReader();
    let resolveRefresh: (() => void) | null = null;
    threadReader.api.refresh = () =>
      new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      });
    const session = createFakeSession({
      identities: [{ pubkey: "agent-pubkey", name: "Review Bot" }],
      channels: [
        { id: "channel-1", name: "eng-reviews", members: ["agent-pubkey"] },
      ],
      send: () => "event-123",
      thread: () => threadReader.api,
    });
    const relay = createFakeRelay({ session, generation: 0 });

    const { rerender } = render(
      <PullRequestDetailView
        token="test-token"
        pullRequest={pullRequest}
        relay={relay}
        relaySnapshot={relay.snapshot()}
        summarySelection={{
          agentPubkey: "agent-pubkey",
          channelId: "channel-1",
        }}
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Send diff to agent" }),
    );
    expect(
      await screen.findByText(/Waiting for Review Bot to reply/i),
    ).toBeInTheDocument();

    // The relay reconnects (new generation) while the initial refresh() is
    // still pending; the watch is disposed and state resets to idle.
    const reconnectedRelay = createFakeRelay({ session, generation: 1 });
    rerender(
      <PullRequestDetailView
        token="test-token"
        pullRequest={pullRequest}
        relay={reconnectedRelay}
        relaySnapshot={reconnectedRelay.snapshot()}
        summarySelection={{
          agentPubkey: "agent-pubkey",
          channelId: "channel-1",
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Send diff to agent" }),
    ).toBeInTheDocument();

    // The stale refresh() from the disposed watch resolves after the reset.
    threadReader.setReplies([message({ authorId: "agent-pubkey" })]);
    await act(async () => {
      resolveRefresh?.();
      await Promise.resolve();
    });

    // It must not resurrect the torn-down watch's "replied" state.
    expect(
      screen.getByRole("button", { name: "Send diff to agent" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Summary text")).not.toBeInTheDocument();
  });
});

describe("PullRequestDetailView agent summary coverage disclosure", () => {
  it("shows included/omitted file coverage before the user clicks Send, not only after", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve(
          url.includes("/compare/")
            ? jsonResponse({
                files: [
                  {
                    filename: "a.ts",
                    status: "modified",
                    additions: 1,
                    deletions: 1,
                    patch: "@@ -1 +1 @@\n-a\n+b",
                  },
                  {
                    filename: "big.bin",
                    status: "modified",
                    additions: 0,
                    deletions: 0,
                    patch: null,
                  },
                ],
              })
            : jsonResponse({
                html_url: pullRequest.url,
                number: pullRequest.number,
                title: pullRequest.title,
                body: "",
                user: { login: pullRequest.author },
                head: { sha: "head-sha", ref: "feature" },
                base: { ref: "main", sha: "base-sha" },
              }),
        ),
      ),
    );
    const session = createFakeSession({
      identities: [{ pubkey: "agent-pubkey", name: "Review Bot" }],
      channels: [
        { id: "channel-1", name: "eng-reviews", members: ["agent-pubkey"] },
      ],
    });
    const relay = createFakeRelay({ session });

    render(
      <PullRequestDetailView
        token="test-token"
        pullRequest={pullRequest}
        relay={relay}
        relaySnapshot={relay.snapshot()}
        summarySelection={{
          agentPubkey: "agent-pubkey",
          channelId: "channel-1",
        }}
      />,
    );

    expect(
      await screen.findByText(/Will include 1 changed file/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /1 file\(s\) omitted: big\.bin \(no patch available from GitHub\)/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send diff to agent" }),
    ).toBeEnabled();
  });

  it("disables Send and explains why when no file has a usable diff", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve(
          url.includes("/compare/")
            ? jsonResponse({
                files: [
                  {
                    filename: "big.bin",
                    status: "modified",
                    additions: 0,
                    deletions: 0,
                    patch: null,
                  },
                ],
              })
            : jsonResponse({
                html_url: pullRequest.url,
                number: pullRequest.number,
                title: pullRequest.title,
                body: "",
                user: { login: pullRequest.author },
                head: { sha: "head-sha", ref: "feature" },
                base: { ref: "main", sha: "base-sha" },
              }),
        ),
      ),
    );
    const session = createFakeSession({
      identities: [{ pubkey: "agent-pubkey", name: "Review Bot" }],
      channels: [
        { id: "channel-1", name: "eng-reviews", members: ["agent-pubkey"] },
      ],
    });
    const relay = createFakeRelay({ session });

    render(
      <PullRequestDetailView
        token="test-token"
        pullRequest={pullRequest}
        relay={relay}
        relaySnapshot={relay.snapshot()}
        summarySelection={{
          agentPubkey: "agent-pubkey",
          channelId: "channel-1",
        }}
      />,
    );

    expect(
      await screen.findByText(/No diff is available to send/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send diff to agent" }),
    ).toBeDisabled();
  });
});
