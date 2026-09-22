// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { keypair, message, signed } from "../relay/testing";
import type { ReactNode } from "react";
import { ChannelTimeline } from "./ChannelTimeline";
import { sessionsData } from "../../../tests/fixtures/channel-sessions-data";
import type { Contribution } from "../../plugins/contributions";
import type {
  ChannelThreadDirectory,
  ConversationExtensions,
} from "../conversation/contracts";
import type { PageNavigation } from "../navigation/service";
// Virtualization geometry is asserted in both real browsers. Render every row here
// to assert projection and reading leases through real React and the real hook.
vi.mock("virtua", () => ({
  Virtualizer: ({ children }: { children: ReactNode }) => <ol>{children}</ol>,
}));
const owners: ReturnType<typeof sessionsData>[] = [];
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    { width: 800, height: 500 },
  ] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: 0,
    bottom: 100,
    left: 0,
    right: 100,
    width: 100,
    height: 100,
  } as DOMRect);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  for (const h of owners.splice(0)) h.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("quiet roots stay in the session window but not rendered/read; plugin removal and exact navigation fall back to readable rows", async () => {
  const data = sessionsData({ rowCount: 0 });
  owners.push(data);
  data.session.channels.ensureList();
  await waitFor(() =>
    expect(data.session.channels.list().status).toBe("ready"),
  );
  const id = await data.session.messages.startChannelSession(
    "general",
    "quiet root",
    [data.member],
    { id: crypto.randomUUID(), createdAt: Math.floor(Date.now() / 1000) },
  );
  await waitFor(() => expect(data.report.published).toHaveLength(1));
  data.session.channels.ensure("general");
  await waitFor(() =>
    expect(data.session.channels.window("general").status).toBe("ready"),
  );
  // A, quiet Q, B are retained together; only actual DOM rows earn dwell.
  const author = keypair();
  const accepted = data.report.published[0];
  if (!accepted) throw new Error("Missing accepted root");
  const quietAt = accepted.created_at;
  const a = message(author, "general", "visible A", quietAt - 1);
  const b = message(author, "general", "visible B", quietAt + 1);
  data.ingest([a, b]);
  const entry: Contribution<ChannelThreadDirectory> = {
    id: "sessions",
    title: "Sessions",
    pluginId: "buzz.sessions",
    key: "buzz.sessions/sessions",
    revision: "1",
    component: () => null,
  };
  let entries = [entry];
  const listeners = new Set<() => void>();
  const empty = [] as const;
  const extensions: ConversationExtensions = {
    tools: { snapshot: () => empty, subscribe: () => () => {} },
    inline: { snapshot: () => empty, subscribe: () => () => {} },
    channelDirectories: {
      snapshot: () => entries,
      subscribe(fn) {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    },
  };
  const viewed: string[][] = [],
    observed: string[][] = [];
  const sync = {
    ...data.session.unread.sync(),
    capability: "frontier-sync" as const,
  };
  const session = {
    ...data.session,
    unread: {
      ...data.session.unread,
      sync: () => sync,
      reading: () => ({
        view: (ids: readonly string[]) => {
          viewed.push([...ids]);
        },
        observe: async (ids: readonly string[]) => {
          observed.push([...ids]);
        },
        dispose() {},
      }),
    },
  };
  const props = {
    session,
    queries: session,
    scope: "test",
    channelId: "general",
    window: session.channels.window("general"),
    extensions,
    onOpenLink: () => false,
  };
  const view = render(<ChannelTimeline {...props} />);
  expect(
    session.channels
      .window("general")
      .rows.some((row) => row.id === id && row.quietSession),
  ).toBe(true);
  expect(view.container.querySelector(`[data-message-id='${id}']`)).toBeNull();
  const history = screen.getByRole("region", {
    name: "Channel message history",
  });
  // The real settling frame precedes read dwell. The controlled clock starts only
  // after the mount completed and then crosses the hook's 750ms boundary.
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  vi.useFakeTimers();
  act(() => {
    history.focus();
    fireEvent.keyDown(history, { key: "ArrowDown" });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(750);
  });
  expect(viewed.flat()).not.toContain(id);
  expect(observed.flat()).not.toContain(id);
  expect(observed.flat()).toContain(b.id);
  expect(viewed.length).toBeGreaterThan(0);
  vi.useRealTimers();
  act(() => {
    entries = [];
    for (const fn of listeners) fn();
  });
  expect(
    view.container.querySelector(`[data-message-id='${id}']`),
  ).not.toBeNull();
  act(() => {
    entries = [entry];
    for (const fn of listeners) fn();
  });
  expect(view.container.querySelector(`[data-message-id='${id}']`)).toBeNull();
  const navigation = {
    target: { kind: "conversation", channelId: "general", messageId: id },
    signal: new AbortController().signal,
    complete: vi.fn(),
  } as unknown as PageNavigation;
  view.rerender(<ChannelTimeline {...props} navigation={navigation} />);
  expect(
    view.container.querySelector(`[data-message-id='${id}']`),
  ).not.toBeNull();
});

it.each(["stream", "forum", "dm", "session"] as const)(
  "%s roots require a known original agent recipient; late evidence and loss fall back without mutating history",
  async (channelType) => {
    const h = sessionsData({ rowCount: 0, channelType });
    owners.push(h);
    h.session.channels.ensureList();
    await waitFor(() => expect(h.session.channels.list().status).toBe("ready"));
    h.agentHint(false);
    const author = keypair();
    const marker = ["buzz-session", "1", "quiet"];
    const noRecipient = message(
      author,
      "general",
      "marked without recipient",
      h.now + 1,
      [marker],
    );
    const human = message(author, "general", "marked human", h.now + 2, [
      marker,
      ["p", h.human],
    ]);
    const candidate = message(
      author,
      "general",
      "marked potential agent",
      h.now + 3,
      [marker, ["p", h.member]],
    );
    const edit = signed(author, {
      kind: 40003,
      content: "edited potential agent",
      created_at: h.now + 4,
      tags: [
        ["h", "general"],
        ["e", candidate.id],
        ["p", h.human],
      ],
    });
    h.ingest([noRecipient, human, candidate, edit]);
    h.session.channels.ensure("general");
    await waitFor(() =>
      expect(h.session.channels.window("general").status).toBe("ready"),
    );
    const originalRows = h.session.channels.window("general").rows;
    const entry: Contribution<ChannelThreadDirectory> = {
      id: "sessions",
      title: "Sessions",
      pluginId: "buzz.sessions",
      key: "buzz.sessions/sessions",
      revision: "1",
      component: () => null,
    };
    const entries = [entry],
      empty = [] as const;
    const extensions: ConversationExtensions = {
      tools: { snapshot: () => empty, subscribe: () => () => {} },
      inline: { snapshot: () => empty, subscribe: () => () => {} },
      channelDirectories: {
        snapshot: () => entries,
        subscribe: () => () => {},
      },
    };
    const view = render(
      <ChannelTimeline
        queries={h.session}
        scope="test"
        channelId="general"
        window={h.session.channels.window("general")}
        extensions={extensions}
        onOpenLink={() => false}
      />,
    );
    const row = (id: string) =>
      view.container.querySelector(`[data-message-id='${id}']`);
    expect(row(noRecipient.id)).not.toBeNull();
    expect(row(human.id)).not.toBeNull();
    expect(row(candidate.id)).not.toBeNull();
    act(() => h.agentHint(true));
    await waitFor(() => {
      if (channelType === "stream" || channelType === "forum")
        expect(row(candidate.id)).toBeNull();
      else expect(row(candidate.id)).not.toBeNull();
    });
    expect(row(noRecipient.id)).not.toBeNull();
    expect(row(human.id)).not.toBeNull();
    expect(originalRows.find((row) => row.id === candidate.id)).toMatchObject({
      content: "edited potential agent",
      mentions: [h.member],
      quietSession: true,
    });
    act(() => h.agentHint(false));
    await waitFor(() => expect(row(candidate.id)).not.toBeNull());
    expect(h.session.channels.window("general").rows).toBe(originalRows);
    if (channelType === "stream") {
      act(() => h.agentHint(true));
      await waitFor(() => expect(row(candidate.id)).toBeNull());
      // Force the actual shared profile budget to evict the oldest identity.
      // Signed unrelated profile data is still display evidence, not an agent query.
      const filler = Array.from({ length: 70 }, () =>
        signed(keypair(), {
          kind: 0,
          content: JSON.stringify({ name: "other", about: "x".repeat(32000) }),
          tags: [],
        }),
      );
      act(() => h.ingest(filler));
      await waitFor(() =>
        expect(h.session.profiles.snapshot().has(h.member)).toBe(false),
      );
      expect(row(candidate.id)).not.toBeNull();
      expect(h.session.channels.window("general").rows).toBe(originalRows);
    }
  },
);
