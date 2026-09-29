// @vitest-environment jsdom
import { createAgentLibrary } from "../../features/agents/library";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  ACTIVITY_RECORD_LIMIT,
  createAgentActivity,
} from "../../features/agents/activity";
import { bindNames } from "../../features/identity-names/service";
import { createAgentDirectory } from "../../features/identity-names/testing";
import { ActivityAccessory } from "./ActivityAccessory";
import { stubPopoverBrowserApis } from "./popover-testing";
stubPopoverBrowserApis();

import { TypingPresentation } from "../../features/conversation/typing-presentation";
import { TypingIndicator } from "../../features/messages/TypingIndicator";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelMessage } from "../../features/relay/contracts";
afterEach(cleanup);
it("shows immediate thread intent without telemetry, keeps waiting after typing expires, and hides channel entries", async () => {
  let generation = 0;
  const service = createAgentActivity(
    true,
    (next) => {
      generation = next ?? 0;
    },
    () => true,
  );
  const release = service.queries.activate();
  service.state({
    status: "connected",
    routes: [{ id: "observer", status: "live", replay: "unknown" }],
  });
  const agent = "c".repeat(64),
    root = "d".repeat(64);
  const profiles = new Map([[agent, { name: "Rivet" }]]);
  const session = {
    agentActivity: service.queries,
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    media: (url: string) => url,
  } as unknown as RelaySession;
  const request = {
    message: {
      id: root,
      channelId: "alpha",
      delivery: "sending",
    } as ChannelMessage,
    agents: [agent],
  };
  const props = {
    session,
    scope: "scope",
    channelId: "alpha",
    threadRootId: root,
    request,
    canOpen: () => true,
    open: vi.fn(() => true),
  };
  const view = render(<ActivityAccessory {...props} />, {
    reactStrictMode: true,
  });
  try {
    const entry = screen.getByRole("button", { name: "Sending request…" });
    fireEvent.click(entry);
    expect(await screen.findByText(/No activity received yet/)).toBeTruthy();
    expect(props.open).not.toHaveBeenCalled();
    const settled = {
      ...request,
      message: { ...request.message, delivery: "seen" as const },
    };
    view.rerender(<ActivityAccessory {...props} request={settled} />);
    expect(
      screen.getByRole("button", { name: "Waiting for response…" }),
    ).toBeTruthy();
    act(() =>
      service.receive(
        {
          id: "e".repeat(64),
          agent,
          createdAt: Math.floor(Date.now() / 1000),
          plaintext: JSON.stringify({
            kind: "turn_error",
            channelId: "alpha",
            turnId: "turn",
            timestamp: new Date().toISOString(),
            payload: {
              error: "<img src=x onerror=bad> Model rejected the request",
            },
          }),
        },
        generation,
      ),
    );
    // Channel activity is inspectable, but is not falsely attributed to this thread.
    expect(
      screen.getByRole("button", { name: "Waiting for response…" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn error" })).toBeNull();
    act(() =>
      service.channelEvents([
        {
          id: "typing",
          kind: 20002,
          pubkey: agent,
          content: "",
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["h", "alpha"],
            ["e", root, "", "reply"],
          ],
        },
      ]),
    );
    expect(
      screen.getByRole("button", { name: "Waiting for response…" }),
    ).toBeTruthy();
    act(() => service.clear());
    expect(
      screen.getByRole("button", { name: "Waiting for response…" }),
    ).toBeTruthy();
    expect(
      screen.queryByText("<img src=x onerror=bad> Model rejected the request"),
    ).toBeNull();
    view.rerender(
      <ActivityAccessory
        {...props}
        request={{
          ...request,
          message: { ...request.message, delivery: "failed" },
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Request not sent" }),
    ).toBeTruthy();
    view.rerender(
      <ActivityAccessory
        {...props}
        request={{
          ...request,
          message: { ...request.message, delivery: "unknown" },
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Delivery unconfirmed" }),
    ).toBeTruthy();
    view.rerender(<ActivityAccessory {...props} threadRootId={undefined} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  } finally {
    view.unmount();
    release();
    service.dispose();
  }
});
it("keeps retained activity on a thread reply without querying profiles; channel replies do not decorate", async () => {
  let generation = 0;
  const activity = createAgentActivity(
    true,
    (next) => {
      generation = next ?? 0;
    },
    () => true,
  );
  const release = activity.queries.activate();
  const agent = "a".repeat(64),
    root = "b".repeat(64);
  const profiles = new Map([[agent, { name: "Rivet" }]]);
  const ensure = vi.fn();
  const session = {
    agentActivity: activity.queries,
    profiles: { snapshot: () => profiles, subscribe: () => () => {}, ensure },
    media: (url: string) => url,
  } as unknown as RelaySession;
  const message = {
    id: "reply",
    authorId: agent,
    channelId: "alpha",
    threadRootId: root,
  } as ChannelMessage;
  act(() =>
    activity.receive(
      {
        id: "c".repeat(64),
        agent,
        createdAt: Math.floor(Date.now() / 1000),
        plaintext: JSON.stringify({
          kind: "turn_completed",
          channelId: "alpha",
          turnId: "turn",
          timestamp: new Date().toISOString(),
        }),
      },
      generation,
    ),
  );
  const props = {
    session,
    scope: "scope",
    channelId: "alpha",
    message,
    threadRootId: root,
    canOpen: () => true,
    open: () => true,
  };
  const view = render(<ActivityAccessory {...props} />, {
    reactStrictMode: true,
  });
  try {
    expect(ensure).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View activity" }));
    expect(
      await screen.findByText(/Activity unavailable for this response/),
    ).toBeTruthy();
    act(() => release());
    expect(screen.queryByText("View activity")).toBeNull();
  } finally {
    view.unmount();
    release();
    activity.dispose();
  }
});
it("renders explicitly linked tools while no reply exists, keeps fast commands open and observes freshness", () => {
  vi.useFakeTimers();
  let generation = 0;
  const service = createAgentActivity(
    true,
    (next) => {
      generation = next ?? 0;
    },
    () => true,
  );
  const release = service.queries.activate();
  service.state({
    status: "connected",
    routes: [{ id: "observer", status: "live", replay: "unknown" }],
  });
  const agent = "a".repeat(64),
    requestId = "b".repeat(64);
  const profiles = new Map([[agent, { name: "Rivet" }]]);
  const session = {
    agentActivity: service.queries,
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    media: (url: string) => url,
  } as unknown as RelaySession;
  const request = {
    message: {
      id: requestId,
      channelId: "alpha",
      delivery: "seen",
    } as ChannelMessage,
    agents: [agent],
  };
  let seq = 0;
  const send = (
    kind: string,
    payload: unknown,
    turnId = "ours",
    author = agent,
  ) =>
    act(() =>
      service.receive(
        {
          id: (++seq).toString(16).padStart(64, "0"),
          agent: author,
          createdAt: Math.floor(Date.now() / 1000),
          plaintext: JSON.stringify({
            seq,
            kind,
            turnId,
            channelId: "alpha",
            timestamp: new Date().toISOString(),
            payload,
          }),
        },
        generation,
      ),
    );
  const tool = (title: string) => ({
    method: "session/update",
    params: {
      sessionId: "S",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: title,
        title: "buzz-dev-mcp__shell",
        status: "completed",
        rawInput: { command: title, workdir: ".buzz" },
      },
    },
  });
  const view = render(
    <ActivityAccessory
      session={session}
      scope="scope"
      channelId="alpha"
      threadRootId={requestId}
      request={request}
      canOpen={() => true}
      open={() => true}
    />,
    { reactStrictMode: true },
  );
  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Waiting for response…" }),
    );
    send("turn_started", { triggeringEventIds: ["c".repeat(64)] }, "other");
    send("acp_read", tool("unrelated"), "other");
    expect(screen.queryByText(/unrelated/)).toBeNull();
    const otherAgent = "d".repeat(64);
    send(
      "turn_started",
      { triggeringEventIds: ["c".repeat(64)] },
      "other-agent",
      otherAgent,
    );
    act(() =>
      service.channelEvents([
        {
          id: "other-typing",
          kind: 20002,
          pubkey: otherAgent,
          content: "",
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["h", "alpha"],
            ["e", requestId, "", "reply"],
          ],
        },
      ]),
    );
    expect(
      screen.getAllByRole("button", { name: "Waiting for response…" }),
    ).toHaveLength(1);
    expect(screen.queryByText(`Agent ${otherAgent.slice(0, 8)}`)).toBeNull();
    send("turn_started", { triggeringEventIds: [requestId] });
    expect(screen.getByRole("button", { name: "Working…" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Turn" })).toBeNull();
    expect(view.container.querySelector("time")).toBeNull();
    send("acp_read", tool("cat > REPORT.md"));
    send("acp_read", tool("wc -w REPORT.md"));
    const group = screen.getByRole("button", { name: /2 commands/ });
    expect(group.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByRole("button", { name: /cat > REPORT.md/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /wc -w REPORT.md/ }),
    ).toBeTruthy();
    fireEvent.click(group);
    send("turn_liveness", {});
    expect(group.getAttribute("aria-expanded")).toBe("false");
    act(() => vi.advanceTimersByTime(31_000));
    expect(screen.getByRole("button", { name: "Status unknown" })).toBeTruthy();
    act(() => service.clear());
    expect(screen.queryByRole("button", { name: /2 commands/ })).toBeNull();
  } finally {
    view.unmount();
    release();
    service.dispose();
    vi.useRealTimers();
  }
});

it.each([false, true])(
  "keeps feed health/retry inside expanded activity, not delivery labels (message=%s)",
  (response) => {
    const activity = createAgentActivity(
      true,
      () => {},
      () => true,
    );
    const release = activity.queries.activate();
    const live = {
      status: "connected" as const,
      routes: [
        { id: "observer", status: "live" as const, replay: "unknown" as const },
      ],
    };
    activity.state(live);
    const agent = "a".repeat(64),
      root = "b".repeat(64);
    const profiles = new Map([[agent, { name: "Rivet", isAgent: true }]]);
    const retry = vi.fn(() => activity.state(live));
    const session = {
      agentActivity: activity.queries,
      profiles: {
        snapshot: () => profiles,
        subscribe: () => () => {},
        ensure: async () => {},
      },
      media: () => undefined,
      live: { retry },
    } as unknown as RelaySession;
    const message = {
      id: "c".repeat(64),
      authorId: agent,
      channelId: "alpha",
      agentEnvelope: true,
    } as ChannelMessage;
    const request = {
      message: {
        id: root,
        channelId: "alpha",
        delivery: "failed",
      } as ChannelMessage,
      agents: [agent],
    };
    const view = render(
      <ActivityAccessory
        session={session}
        scope="scope"
        channelId="alpha"
        threadRootId={root}
        {...(response ? { message } : { request })}
        canOpen={() => true}
        open={() => true}
      />,
      { reactStrictMode: true },
    );
    try {
      act(() => activity.state({ status: "retrying", routes: [] }));
      expect(screen.queryByText(/Feed: interrupted/)).toBeNull();
      fireEvent.click(
        screen.getByRole("button", {
          name: response ? "View activity" : "Request not sent",
        }),
      );
      expect(screen.getByText(/Feed: interrupted/)).toBeTruthy();
      expect(screen.queryByText(/No activity received yet/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Retry live feed" }));
      expect(retry).toHaveBeenCalledOnce();
      expect(
        screen.queryByRole("button", { name: "Retry live feed" }),
      ).toBeNull();
      expect(
        screen
          .getByRole("button", {
            name: response ? "View activity" : "Request not sent",
          })
          .getAttribute("aria-expanded"),
      ).toBe("true");
    } finally {
      view.unmount();
      release();
      activity.dispose();
    }
  },
);

it("updates a request headline and replaces typing only for healthy visible work", () => {
  vi.useFakeTimers();
  let generation = 0;
  const activity = createAgentActivity(
    true,
    (next) => {
      generation = next ?? 0;
    },
    () => true,
  );
  const release = activity.queries.activate();
  const live = {
    status: "connected" as const,
    routes: [
      { id: "observer", status: "live" as const, replay: "unknown" as const },
    ],
  };
  activity.state(live);
  const agent = "a".repeat(64),
    root = "b".repeat(64);
  const profiles = new Map([[agent, { name: "Blossom" }]]);
  const typing = [{ pubkey: agent, channelId: "alpha" }];
  const session = {
    agentActivity: activity.queries,
    agentChoices: createAgentLibrary(undefined).queries,
    typing: { snapshot: () => typing, subscribe: () => () => {} },
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    media: () => undefined,
  } as unknown as RelaySession;
  const request = {
    message: {
      id: root,
      channelId: "alpha",
      delivery: "seen",
    } as ChannelMessage,
    agents: [agent],
  };
  const tree = (
    shown = true,
    active = true,
    delivery: ChannelMessage["delivery"] = "seen",
  ) => (
    <TypingPresentation active={active}>
      {shown && (
        <ActivityAccessory
          session={session}
          scope="scope"
          channelId="alpha"
          threadRootId={root}
          request={{ ...request, message: { ...request.message, delivery } }}
          canOpen={() => true}
          open={() => true}
        />
      )}
      <TypingIndicator session={session} channelId="alpha" />
    </TypingPresentation>
  );
  const view = render(tree(), { reactStrictMode: true });
  let seq = 0;
  const send = (kind: string, payload: unknown) =>
    act(() =>
      activity.receive(
        {
          id: (++seq).toString(16).padStart(64, "0"),
          agent,
          createdAt: Math.floor(Date.now() / 1000),
          plaintext: JSON.stringify({
            seq,
            kind,
            channelId: "alpha",
            turnId: "T",
            timestamp: new Date().toISOString(),
            payload,
          }),
        },
        generation,
      ),
    );
  const update = (value: unknown) =>
    send("acp_read", {
      method: "session/update",
      params: { sessionId: "S", update: value },
    });
  try {
    expect(
      screen.getByRole("status", { name: "Typing activity" }),
    ).toBeTruthy();
    send("turn_started", { triggeringEventIds: [root] });
    expect(screen.getByRole("button", { name: "Working…" })).toBeTruthy();
    expect(
      screen.queryByRole("status", { name: "Typing activity" }),
    ).toBeNull();
    update({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "private reasoning" },
    });
    expect(screen.getByRole("button", { name: "Thinking…" })).toBeTruthy();
    expect(
      screen.getByRole("status", { name: "Agent activity status" }).textContent,
    ).toBe("Blossom is working. Thinking…");
    expect(screen.queryByText("private reasoning")).toBeNull();
    update({
      sessionUpdate: "tool_call",
      toolCallId: "tool",
      title: "buzz-dev-mcp__shell",
      status: "in_progress",
    });
    expect(
      screen.getByRole("button", { name: "Running a command…" }),
    ).toBeTruthy();
    view.rerender(tree(true, false));
    expect(
      screen.getByRole("status", { name: "Typing activity" }),
    ).toBeTruthy();
    view.rerender(tree(true, true, "failed"));
    expect(
      screen.getByRole("button", { name: "Request not sent" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("status", { name: "Typing activity" }),
    ).toBeTruthy();
    view.rerender(tree());
    act(() => activity.state({ status: "retrying", routes: [] }));
    expect(
      screen.getByRole("status", { name: "Typing activity" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Status unknown" })).toBeTruthy();
    act(() => activity.state(live));
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool",
      status: "completed",
    });
    expect(
      screen.getByRole("button", { name: "Last action: Run command" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("status", { name: "Agent activity status" }).textContent,
    ).toBe("Blossom is working. Last action: Run command");
    expect(
      screen.queryByRole("status", { name: "Typing activity" }),
    ).toBeNull();
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Response" },
    });
    expect(
      screen.getByRole("button", { name: "Writing a response…" }),
    ).toBeTruthy();
    act(() => vi.advanceTimersByTime(31_000));
    expect(screen.getByRole("button", { name: "Status unknown" })).toBeTruthy();
    expect(
      screen.getByRole("status", { name: "Typing activity" }),
    ).toBeTruthy();
    send("turn_liveness", {});
    expect(
      screen.queryByRole("status", { name: "Typing activity" }),
    ).toBeNull();
    view.rerender(tree(false));
    expect(
      screen.getByRole("status", { name: "Typing activity" }),
    ).toBeTruthy();
    view.rerender(tree());
    send("turn_completed", {});
    expect(
      screen.getByRole("button", { name: "Observed activity ended" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("status", { name: "Typing activity" }),
    ).toBeTruthy();
  } finally {
    view.unmount();
    release();
    activity.dispose();
    vi.useRealTimers();
  }
});

it.each([false, true])(
  "derives typing priority from the actual root/follow-up request (followUp=%s)",
  (followUp) => {
    const agent = "a".repeat(64),
      human = "c".repeat(64),
      root = "b".repeat(64);
    const requestId = followUp ? "d".repeat(64) : root;
    let generation = 0;
    const activity = createAgentActivity(
      true,
      (next) => {
        generation = next ?? 0;
      },
      () => true,
    );
    const release = activity.queries.activate();
    activity.state({
      status: "connected",
      routes: [{ id: "observer", status: "live", replay: "unknown" }],
    });
    const profiles = new Map([
      [agent, { name: "Blossom" }],
      [human, { name: "Blossom" }],
    ]);
    const entries = [undefined, root, "sibling"].flatMap((threadRootId) =>
      [agent, human].map((pubkey) => ({
        pubkey,
        channelId: "alpha",
        threadRootId,
      })),
    );
    const session = {
      agentActivity: activity.queries,
      agentChoices: createAgentLibrary(undefined).queries,
      typing: { snapshot: () => entries, subscribe: () => () => {} },
      profiles: {
        snapshot: () => profiles,
        subscribe: () => () => {},
        ensure: async () => {},
      },
      media: () => undefined,
    } as unknown as RelaySession;
    activity.receive(
      {
        id: "e".repeat(64),
        agent,
        createdAt: Math.floor(Date.now() / 1000),
        plaintext: JSON.stringify({
          kind: "turn_started",
          turnId: "T",
          channelId: "alpha",
          seq: 1,
          timestamp: new Date().toISOString(),
          payload: { triggeringEventIds: [requestId] },
        }),
      },
      generation,
    );
    const request = {
      agents: [agent],
      message: {
        id: requestId,
        channelId: "alpha",
        delivery: "seen",
        ...(followUp ? { threadRootId: root } : {}),
      } as ChannelMessage,
    };
    const tree = (shown: boolean) => (
      <TypingPresentation active>
        {shown && (
          <ActivityAccessory
            session={session}
            scope="scope"
            channelId="alpha"
            threadRootId={root}
            request={request}
            canOpen={() => true}
            open={() => true}
          />
        )}
        {[undefined, root, "sibling"].map((scope) => (
          <section key={scope ?? "channel"} aria-label={scope ?? "channel"}>
            <TypingIndicator
              session={session}
              channelId="alpha"
              threadRootId={scope}
            />
          </section>
        ))}
      </TypingPresentation>
    );
    const view = render(tree(true), { reactStrictMode: true });
    const label = (scope: string) =>
      within(screen.getByRole("region", { name: scope })).getByRole("status", {
        name: "Typing activity",
      }).textContent;
    try {
      expect(label(root)).toBe("Blossom is typing…"); // Namesake human remains.
      expect(label("sibling")).toBe("Blossom, Blossom are typing…");
      expect(label("channel")).toBe(
        followUp ? "Blossom, Blossom are typing…" : "Blossom is typing…",
      );
      view.rerender(tree(false));
      expect(label(root)).toBe("Blossom, Blossom are typing…");
      expect(label("channel")).toBe("Blossom, Blossom are typing…");
    } finally {
      view.unmount();
      release();
      activity.dispose();
    }
  },
);

it("isolates three request recipients, namesakes, stale work and terminal no-reply evidence", () => {
  vi.useFakeTimers();
  let generation = 0;
  const activity = createAgentActivity(
    true,
    (next) => {
      generation = next ?? 0;
    },
    () => true,
  );
  const release = activity.queries.activate();
  activity.state({
    status: "connected",
    routes: [{ id: "observer", status: "live", replay: "unknown" }],
  });
  const agents = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
  const requestId = "d".repeat(64);
  const profiles = new Map(
    agents.map((key, i) => [
      key,
      { name: i < 2 ? "Honey" : "Scout", isAgent: true as const },
    ]),
  );
  const profileQueries = {
    snapshot: () => profiles,
    subscribe: () => () => {},
    ensure: async () => {},
  };
  const library = {
    status: "ready",
    definitions: [],
    identities: agents.map((pubkey) => ({
      pubkey,
      name: profiles.get(pubkey)?.name ?? "Agent",
    })),
  };
  const directory = createAgentDirectory();
  const names = bindNames(
    {
      profiles: profileQueries,
      agentLibrary: {
        snapshot: () => library,
        subscribe: () => () => {},
        refresh: async () => {},
        retain: () => () => {},
      },
    },
    { snapshot: () => [directory], subscribe: () => () => {} },
  );
  const channelList = {
    status: "ready",
    channels: [{ id: "alpha", members: agents }],
  };
  const session = {
    agentActivity: activity.queries,
    profiles: profileQueries,
    channels: { list: () => channelList, subscribeList: () => () => {} },
    names,
    media: () => undefined,
  } as unknown as RelaySession;
  const request = {
    message: {
      id: requestId,
      channelId: "alpha",
      delivery: "seen",
    } as ChannelMessage,
    agents,
  };
  const view = render(
    <ActivityAccessory
      session={session}
      scope="scope"
      channelId="alpha"
      threadRootId={requestId}
      request={request}
      canOpen={() => true}
      open={() => true}
    />,
    { reactStrictMode: true },
  );
  let serial = 0;
  const emit = (
    key: string,
    kind: string,
    payload: unknown = {},
    channelId = "alpha",
  ) =>
    act(() =>
      activity.receive(
        {
          id: (++serial).toString(16).padStart(64, "0"),
          agent: key,
          createdAt: Math.floor(Date.now() / 1000),
          plaintext: JSON.stringify({
            seq: serial,
            kind,
            payload,
            channelId,
            turnId: key,
            timestamp: new Date().toISOString(),
          }),
        },
        generation,
      ),
    );
  const entry = (key: string) => {
    const label = names.resolve(key, "Agent") ?? "Agent";
    const heading = screen.getByText(label, { selector: "p" });
    if (!heading.parentElement) throw new Error("Missing Activity entry");
    return within(heading.parentElement);
  };
  try {
    expect(names.resolve(agents[0] ?? "")).not.toBe(
      names.resolve(agents[1] ?? ""),
    );
    expect(
      screen.getAllByRole("button", { name: "Waiting for response…" }),
    ).toHaveLength(3);
    for (const key of agents.slice(0, 2))
      emit(key, "turn_started", { triggeringEventIds: [requestId] });
    const first = agents[0] ?? "",
      second = agents[1] ?? "",
      third = agents[2] ?? "";
    emit(
      third,
      "turn_started",
      { triggeringEventIds: [requestId] },
      "other-channel",
    );
    expect(
      entry(third).getByRole("button", { name: "Waiting for response…" }),
    ).toBeTruthy();
    emit(first, "acp_read", {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "First agent only" },
        },
      },
    });
    emit(second, "acp_read", {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "read",
          title: "buzz-dev-mcp__read_file",
          status: "in_progress",
        },
      },
    });
    expect(
      entry(first).getByRole("button", { name: "Thinking…" }),
    ).toBeTruthy();
    expect(
      entry(second).getByRole("button", { name: "Reading file…" }),
    ).toBeTruthy();
    act(() => vi.advanceTimersByTime(20_000));
    emit(second, "turn_liveness");
    act(() => vi.advanceTimersByTime(11_000));
    expect(
      entry(first).getByRole("button", { name: "Status unknown" }),
    ).toBeTruthy();
    expect(
      entry(second).getByRole("button", { name: "Reading file…" }),
    ).toBeTruthy();
    expect(
      entry(third).getByRole("button", { name: "Waiting for response…" }),
    ).toBeTruthy();
    emit(second, "turn_error", { error: "Sample failure without a reply" });
    expect(
      entry(second).getByRole("button", {
        name: "Observed activity ended · error reported",
      }),
    ).toBeTruthy();
    fireEvent.click(
      entry(second).getByRole("button", {
        name: "Observed activity ended · error reported",
      }),
    );
    const popup = within(
      screen.getByRole("dialog", {
        name: names.resolve(second, "Agent") ?? "Agent",
      }),
    );
    fireEvent.click(popup.getByRole("button", { name: /Turn error/ }));
    expect(popup.getByText("Sample failure without a reply")).toBeTruthy();
    expect(
      entry(first).getByRole("button", { name: "Status unknown" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View activity" })).toBeNull();
  } finally {
    view.unmount();
    names.dispose();
    release();
    activity.dispose();
    vi.useRealTimers();
  }
});

it.each([2, 3, 4, 7])(
  "shows %i pending agents independently without hiding identity, delivery or typing evidence",
  async (count) => {
    const user = userEvent.setup();
    let generation = 0;
    const activity = createAgentActivity(
      true,
      (next) => {
        generation = next ?? 0;
      },
      () => true,
    );
    const release = activity.queries.activate();
    activity.state({
      status: "connected",
      routes: [{ id: "observer", status: "live", replay: "unknown" }],
    });
    const agents = Array.from({ length: count }, (_, i) =>
      (i + 1).toString().repeat(64),
    );
    const root = "a".repeat(64);
    const profiles = new Map(
      agents.map((key, i) => [key, { name: `Agent ${i + 1}` }]),
    );
    const typing = [{ pubkey: agents[0], channelId: "alpha" }];
    const session = {
      agentActivity: activity.queries,
      agentChoices: createAgentLibrary(undefined).queries,
      typing: { snapshot: () => typing, subscribe: () => () => {} },
      profiles: {
        snapshot: () => profiles,
        subscribe: () => () => {},
        ensure: vi.fn(async () => {}),
      },
      media: () => undefined,
    } as unknown as RelaySession;
    const tree = (
      recipients = agents,
      id = root,
      delivery: ChannelMessage["delivery"] = "seen",
    ) => (
      <TypingPresentation active>
        <ActivityAccessory
          key={id}
          session={session}
          scope="scope"
          channelId="alpha"
          threadRootId={root}
          request={{
            agents: recipients,
            message: { id, channelId: "alpha", delivery } as ChannelMessage,
          }}
          canOpen={() => true}
          open={() => true}
        />
        <TypingIndicator session={session} channelId="alpha" />
      </TypingPresentation>
    );
    const view = render(tree(), { reactStrictMode: true });
    try {
      expect(
        screen.getAllByRole("button", { name: "Waiting for response…" }),
      ).toHaveLength(count);
      expect(
        screen.getAllByRole("status", { name: "Agent activity status" }),
      ).toHaveLength(count);
      act(() =>
        activity.receive(
          {
            id: "e".repeat(64),
            agent: agents[0] ?? "",
            createdAt: Math.floor(Date.now() / 1000),
            plaintext: JSON.stringify({
              kind: "turn_started",
              channelId: "alpha",
              turnId: "T",
              seq: 1,
              timestamp: new Date().toISOString(),
              payload: { triggeringEventIds: [root] },
            }),
          },
          generation,
        ),
      );
      // Pending work is visible independently; no aggregate disclosure is needed.
      expect(
        screen.queryByRole("status", { name: "Typing activity" }),
      ).toBeNull();
      for (let i = 0; i < count; i++)
        expect(
          screen.getByText(`Agent ${i + 1}`, { selector: "p" }),
        ).toBeTruthy();
      const working = screen.getByRole("button", { name: "Working…" });
      await user.click(working);
      expect(working.getAttribute("aria-expanded")).toBe("true");
      // A shrinking pending lineup preserves the exact agent's open popup.
      view.rerender(tree([agents[0] ?? ""]));
      expect(screen.getByRole("button", { name: "Working…" })).toBe(working);
      expect(working.getAttribute("aria-expanded")).toBe("true");
      for (const [delivery, label] of [
        ["sending", "Sending request…"],
        ["unknown", "Delivery unconfirmed"],
        ["failed", "Request not sent"],
      ] as const) {
        view.rerender(tree(agents, root, delivery));
        expect(screen.getAllByRole("button", { name: label })).toHaveLength(
          count,
        );
        expect(
          screen.getByRole("status", { name: "Typing activity" }),
        ).toBeTruthy();
      }
      // A new request does not inherit the old agent popup's expansion.
      view.rerender(tree(agents, "f".repeat(64)));
      for (const button of screen.getAllByRole("button", {
        name: "Waiting for response…",
      }))
        expect(button.getAttribute("aria-expanded")).toBe("false");
      view.unmount();
      expect(screen.queryByRole("button")).toBeNull();
    } finally {
      view.unmount();
      release();
      activity.dispose();
    }
  },
);

it.each(["turn_completed", "turn_error", "agent_panic"])(
  "shows %s as observed terminal evidence, not reply delivery, and releases it on reset",
  (kind) => {
    vi.useFakeTimers();
    let generation = 0;
    const activity = createAgentActivity(
      true,
      (next) => {
        generation = next ?? 0;
      },
      () => true,
    );
    let release = activity.queries.activate();
    const live = {
      status: "connected" as const,
      routes: [
        { id: "observer", status: "live" as const, replay: "unknown" as const },
      ],
    };
    activity.state(live);
    const agent = "a".repeat(64),
      root = "b".repeat(64);
    const profiles = new Map([[agent, { name: "Helper" }]]);
    const session = {
      agentActivity: activity.queries,
      profiles: {
        snapshot: () => profiles,
        subscribe: () => () => {},
        ensure: async () => {},
      },
      media: () => undefined,
    } as unknown as RelaySession;
    const tree = (delivery: ChannelMessage["delivery"] = "seen") => (
      <ActivityAccessory
        session={session}
        scope="terminal"
        channelId="alpha"
        threadRootId={root}
        request={{
          message: {
            id: root,
            channelId: "alpha",
            delivery,
          } as ChannelMessage,
          agents: [agent],
        }}
        open={() => false}
        canOpen={() => false}
      />
    );
    const view = render(tree(), { reactStrictMode: true });
    let seq = 0;
    const emit = (eventKind: string, turnId = "one", extra: object = {}) =>
      act(() =>
        activity.receive(
          {
            id: (++seq).toString(16).padStart(64, "0"),
            agent,
            createdAt: Math.floor(Date.now() / 1000),
            plaintext: JSON.stringify({
              kind: eventKind,
              turnId,
              channelId: "alpha",
              seq,
              timestamp: new Date().toISOString(),
              payload: {
                triggeringEventIds: [root],
                error: "Captured terminal detail",
              },
              ...extra,
            }),
          },
          generation,
        ),
      );
    const terminal =
      kind === "turn_completed"
        ? "Observed activity ended"
        : "Observed activity ended · error reported";
    try {
      emit("turn_started");
      emit("acp_read", "one", {
        payload: {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "failed-tool",
              title: "read_file",
              status: "failed",
            },
          },
        },
      });
      expect(screen.queryByRole("button", { name: terminal })).toBeNull();
      act(() => vi.advanceTimersByTime(31_000));
      expect(
        screen.getByRole("button", { name: "Status unknown" }),
      ).toBeTruthy();
      emit(kind);
      expect(screen.getByRole("button", { name: terminal })).toBeTruthy();
      expect(
        screen.getByRole("status", { name: "Agent activity status" })
          .textContent,
      ).toBe(`Helper: ${terminal}`);
      // Coordination has no conversation representation and never settles a request.
      view.rerender(tree("seen"));
      expect(screen.getByRole("button", { name: terminal })).toBeTruthy();
      // A malformed/future later error cannot rewrite the accepted completion.
      emit("turn_error", "one", {
        timestamp: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(screen.getByRole("button", { name: terminal })).toBeTruthy();
      act(() => activity.state({ status: "retrying", routes: [] }));
      expect(screen.getByRole("button", { name: terminal })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: terminal }));
      expect(screen.getByText(/Feed: interrupted/)).toBeTruthy();
      if (kind !== "turn_completed") {
        fireEvent.click(
          screen.getAllByRole("button", {
            name: /Turn error/,
          })[0] as HTMLElement,
        );
        expect(
          screen.getAllByText("Captured terminal detail").length,
        ).toBeGreaterThan(0);
      }
      for (const [delivery, label] of [
        ["sending", "Sending request…"],
        ["unknown", "Delivery unconfirmed"],
        ["failed", "Request not sent"],
      ] as const) {
        view.rerender(tree(delivery));
        expect(screen.getByRole("button", { name: label })).toBeTruthy();
      }
      view.rerender(tree());
      expect(screen.getByRole("button", { name: terminal })).toBeTruthy();
      act(() => activity.state(live));
      view.rerender(tree("seen"));
      emit("turn_started", "two");
      expect(screen.getByRole("button", { name: "Working…" })).toBeTruthy();
      act(() => activity.state({ status: "retrying", routes: [] }));
      expect(
        screen.getByRole("button", { name: "Status unknown" }),
      ).toBeTruthy();
      view.rerender(tree());
      act(() => activity.state(live));
      emit("turn_completed", "two");
      expect(screen.getByRole("button", { name: terminal })).toBeTruthy();
      // Retain the completed second turn while eviction loses the older start.
      // Historical terminal evidence no longer establishes a complete request view.
      const untilFirstEviction =
        ACTIVITY_RECORD_LIMIT - activity.queries.snapshot().records.length + 1;
      for (let i = 0; i < untilFirstEviction; i++)
        emit("other_activity", "noise");
      expect(activity.queries.snapshot().trimmed).toBeGreaterThan(0);
      expect(
        screen.getByRole("button", { name: "Status unknown" }),
      ).toBeTruthy();
      act(() => activity.clear());
      expect(screen.queryByRole("button", { name: terminal })).toBeNull();
      act(() => activity.state(live));
      emit("turn_started");
      emit(kind);
      expect(screen.getByRole("button", { name: terminal })).toBeTruthy();
      act(() => release());
      expect(screen.queryByRole("button", { name: terminal })).toBeNull();
      act(() => {
        release = activity.queries.activate();
        activity.state(live);
      });
      expect(
        screen.getByRole("button", { name: "Waiting for response…" }),
      ).toBeTruthy();
    } finally {
      view.unmount();
      release();
      activity.dispose();
      vi.useRealTimers();
    }
  },
);
