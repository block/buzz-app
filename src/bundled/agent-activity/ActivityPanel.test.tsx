// @vitest-environment jsdom
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { bindNames } from "../../features/identity-names/service";
import { createAgentActivity } from "../../features/agents/activity";
import type { RelaySession } from "../../features/relay/session";
import { createAgentLibrary } from "../../features/agents/library";
import { ActivityDetails } from "./ActivityPanel";
import {
  createThreadViews,
  ThreadViews,
} from "../../features/messages/thread-views";
import type { ThreadSnapshot } from "../../features/relay/threads";
import type { ChannelMessage } from "../../features/relay/contracts";

afterEach(cleanup);
const agent = "a".repeat(64);
it("projects actual session activity into turn/tool details, keeps raw access and clears on reset", async () => {
  let generation: number | null = null;
  const activity = createAgentActivity(
    true,
    (value) => {
      generation = value;
    },
    () => true,
  );
  const release = activity.queries.activate();
  activity.state({
    status: "connected",
    routes: [{ id: "observer", status: "live", replay: "unknown" }],
  });
  const profiles = new Map([[agent, { name: "Rivet" }]]);
  const channels = {
    status: "ready",
    channels: [{ id: "alpha", name: "Alpha" }],
  };
  const session = {
    agentChoices: createAgentLibrary(undefined).queries,
    agentActivity: activity.queries,
    profiles: { snapshot: () => profiles, subscribe: () => () => {} },
    channels: { list: () => channels, subscribeList: () => () => {} },
    live: { retry() {} },
  } as unknown as RelaySession;
  let serial = 0;
  const send = (kind: string, payload: unknown, turnId = "one") =>
    act(() => {
      activity.receive(
        {
          id: (++serial).toString(16).padStart(64, "0"),
          agent,
          createdAt: Math.floor(Date.now() / 1000),
          plaintext: JSON.stringify({
            kind,
            payload,
            channelId: "alpha",
            sessionId: "S",
            turnId,
            timestamp: new Date().toISOString(),
          }),
        },
        generation ?? 0,
      );
    });
  const tool = (sessionUpdate: string, extra = {}) => ({
    method: "session/update",
    params: {
      sessionId: "S",
      update: { sessionUpdate, toolCallId: "tool", ...extra },
    },
  });
  const view = render(
    <ActivityDetails
      session={session}
      selection={{ agent, channelId: "alpha" }}
    />,
    { reactStrictMode: true },
  );
  try {
    send("turn_started", { triggeringEventIds: ["b".repeat(64)] });
    send("acp_write", {
      method: "session/prompt",
      params: { prompt: [{ type: "text", text: "Fix the composer" }] },
    });
    send(
      "acp_read",
      tool("tool_call", {
        title: "Reading MessageComposer.tsx",
        status: "in_progress",
        rawInput: { path: "MessageComposer.tsx" },
      }),
    );
    const readable = screen.getByRole("region", { name: "Readable activity" });
    fireEvent.click(
      within(readable).getByRole("button", {
        name: "Diagnostics (1)",
      }),
    );
    fireEvent.click(
      within(readable).getByRole("button", { name: "Request context" }),
    );
    expect(await within(readable).findByText("Fix the composer")).toBeTruthy();
    fireEvent.click(
      within(readable).getByRole("button", {
        name: /Reading MessageComposer.tsx/,
      }),
    );
    send(
      "acp_read",
      tool("tool_call_update", {
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: '<img src=x onerror="alert(1)">' },
          },
        ],
      }),
    );
    expect(
      await within(readable).findByText('<img src=x onerror="alert(1)">'),
    ).toBeTruthy();
    expect(readable.querySelector("img")).toBeNull();
    expect(
      within(readable).getAllByRole("button", {
        name: /Reading MessageComposer.tsx/,
      }),
    ).toHaveLength(1);
    expect(
      within(readable).getByRole("button", {
        name: "Reading MessageComposer.tsx",
      }),
    ).toBeTruthy();
    send("turn_completed", {});
    expect(within(readable).getByText("Ended", { exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Raw events" }));
    expect(
      await screen.findByRole("button", { name: /turn_started/ }),
    ).toBeTruthy();
    act(() => activity.clear());
    expect(within(readable).queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByText("Fix the composer")).toBeNull();
    expect(
      screen.getByText("Feed: connecting. Current work may be unknown."),
    ).toBeTruthy();
    expect(
      screen.queryByText(/Waiting for live records for this identity/),
    ).toBeNull();
    act(() =>
      activity.state({
        status: "connected",
        routes: [{ id: "observer", status: "live", replay: "unknown" }],
      }),
    );
    expect(
      screen.getByText(/Waiting for live records for this identity/),
    ).toBeTruthy();
    send("turn_liveness", {});
    expect(within(readable).queryByText("Fix the composer")).toBeNull();
    act(() => release());
    expect(within(readable).queryAllByRole("button")).toHaveLength(0);
  } finally {
    view.unmount();
    release();
    activity.dispose();
  }
});

it("pins a response target and cannot fall back to channel selectors after evidence reset", async () => {
  let generation = 0;
  const activity = createAgentActivity(
    true,
    (next) => {
      generation = next ?? 0;
    },
    () => true,
  );
  const release = activity.queries.activate();
  const messageId = "e".repeat(64);
  const profiles = new Map([[agent, { name: "Rivet" }]]);
  const channels = {
    status: "ready",
    channels: [{ id: "alpha", name: "Alpha" }],
  };
  const session = {
    agentChoices: createAgentLibrary(undefined).queries,
    agentActivity: activity.queries,
    profiles: { snapshot: () => profiles, subscribe: () => () => {} },
    channels: { list: () => channels, subscribeList: () => () => {} },
  } as unknown as RelaySession;
  let serial = 0;
  function send(kind: string, payload = {}) {
    const seq = ++serial;
    act(() =>
      activity.receive(
        {
          id: seq.toString(16).padStart(64, "0"),
          agent,
          createdAt: Math.floor(Date.now() / 1000),
          plaintext: JSON.stringify({
            seq,
            kind,
            channelId: "alpha",
            turnId: "T",
            sessionId: "S",
            payload,
            timestamp: new Date().toISOString(),
          }),
        },
        generation,
      ),
    );
  }
  send("turn_started");
  send("acp_read", {
    method: "session/update",
    params: {
      sessionId: "S",
      update: {
        sessionUpdate: "tool_call",
        title: "buzz-dev-mcp__shell",
        toolCallId: "send",
        rawInput: {
          command: "buzz messages send --channel alpha --content 'Reply'",
        },
      },
    },
  });
  send("acp_read", {
    method: "session/update",
    params: {
      sessionId: "S",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "send",
        status: "completed",
        rawOutput: { isError: false },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: JSON.stringify({
                exit_code: 0,
                timed_out: false,
                stdout_truncated: false,
                stdout: JSON.stringify({
                  accepted: true,
                  event_id: messageId,
                  message: "",
                  mention_pubkeys: [],
                }),
              }),
            },
          },
        ],
      },
    },
  });
  const view = render(
    <ActivityDetails
      session={session}
      selection={{ agent, channelId: "alpha", messageId }}
    />,
    { reactStrictMode: true },
  );
  try {
    fireEvent.click(
      screen.getByRole("button", { name: /Run command · buzz messages send/ }),
    );
    expect(screen.getByText("Send message · Reported sent")).toBeTruthy();
    expect(
      screen.queryByText("Message text is not included in this activity."),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /Send message · Reported sent/ }),
    );
    expect(
      screen.getByText("Message text is not included in this activity."),
    ).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    act(() => activity.clear());
    expect(
      await screen.findByText(/No activity is retained for this agent here/),
    ).toBeTruthy();
    expect(screen.getByText(/clears when the app reloads/)).toBeTruthy();
    expect(screen.queryByText("Send message · Reported sent")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  } finally {
    view.unmount();
    release();
    activity.dispose();
  }
});

it.each(["messageId", "requestId"] as const)(
  "keeps shared identity names reactive in %s inspection without retargeting",
  (targetKind) => {
    const activity = createAgentActivity(
      true,
      () => {},
      () => true,
    );
    const profileSnapshot = new Map([[agent, { name: "Public name" }]]);
    const profiles = {
      snapshot: () => profileSnapshot,
      subscribe: () => () => {},
      ensure: async () => {},
    };
    const listeners = new Set<() => void>();
    let name = "Managed name · abcd";
    const provider = {
      id: "fixture-names",
      scope: () => () => ({ name }),
      activate: () => undefined,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const names = bindNames(
      {
        profiles: profiles as RelaySession["profiles"],
        agentLibrary: {
          snapshot: () => ({
            status: "ready",
            identities: [],
            definitions: [],
          }),
          subscribe: () => () => {},
          refresh: async () => {},
          retain: () => () => {},
        },
      },
      { snapshot: () => [provider], subscribe: () => () => {} },
    );
    const channels = { status: "ready", channels: [] };
    const session = {
      names,
      profiles,
      agentChoices: createAgentLibrary(undefined).queries,
      agentActivity: activity.queries,
      channels: { list: () => channels, subscribeList: () => () => {} },
    } as unknown as RelaySession;
    const view = render(
      <ActivityDetails
        session={session}
        selection={{ agent, channelId: "alpha", [targetKind]: "e".repeat(64) }}
      />,
      { reactStrictMode: true },
    );
    try {
      expect(screen.getByText(/Managed name · abcd/)).toBeTruthy();
      act(() => {
        name = "Renamed agent";
        for (const listener of listeners) listener();
      });
      expect(screen.getByText(/Renamed agent/)).toBeTruthy();
      expect(screen.queryByText(/Managed name/)).toBeNull();
      expect(screen.queryByRole("combobox")).toBeNull();
    } finally {
      view.unmount();
      names.dispose();
      activity.dispose();
    }
  },
);

it.each(["general", "requestId", "messageId"] as const)(
  "keeps feed failure/retry visible in %s inspection without changing scope",
  (mode) => {
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
    const requestId = "b".repeat(64);
    activity.receive(
      {
        id: "c".repeat(64),
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
    const profiles = new Map([[agent, { name: "Rivet" }]]);
    const channels = { status: "ready", channels: [] };
    const retry = vi.fn(() => activity.state(live));
    const session = {
      agentChoices: createAgentLibrary(undefined).queries,
      agentActivity: activity.queries,
      profiles: { snapshot: () => profiles, subscribe: () => () => {} },
      channels: { list: () => channels, subscribeList: () => () => {} },
      live: { retry },
    } as unknown as RelaySession;
    const selection = {
      agent,
      channelId: "alpha",
      ...(mode === "general" ? {} : { [mode]: requestId }),
    };
    const view = render(
      <ActivityDetails session={session} selection={selection} />,
      { reactStrictMode: true },
    );
    try {
      act(() => activity.state({ status: "retrying", routes: [] }));
      expect(
        screen.getByText("Feed: interrupted. Current work may be unknown."),
      ).toBeTruthy();
      expect(
        screen.queryByText("No activity received for this request yet."),
      ).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Retry live feed" }));
      expect(retry).toHaveBeenCalledOnce();
      expect(
        screen.queryByRole("button", { name: "Retry live feed" }),
      ).toBeNull();
      expect(activity.queries.snapshot().records).toHaveLength(1);
      if (mode !== "general") expect(screen.queryByRole("combobox")).toBeNull();
      act(() => {
        for (let i = 0; i < 201; i++)
          activity.receive(
            {
              id: (i + 100).toString(16).padStart(64, "0"),
              agent,
              createdAt: Math.floor(Date.now() / 1000),
              plaintext: JSON.stringify({
                kind: "turn_liveness",
                channelId: "alpha",
              }),
            },
            generation,
          );
      });
      expect(
        screen.getByText(/Retention limited:.*from this feed/),
      ).toBeTruthy();
    } finally {
      view.unmount();
      release();
      activity.dispose();
    }
  },
);

it.each(["requestId", "messageId"] as const)(
  "explains unsupported capture rather than empty %s evidence",
  (mode) => {
    const activity = createAgentActivity(
      false,
      () => {},
      () => true,
    );
    const profiles = new Map();
    const channels = { status: "ready", channels: [] };
    const session = {
      agentChoices: createAgentLibrary(undefined).queries,
      agentActivity: activity.queries,
      profiles: { snapshot: () => profiles, subscribe: () => () => {} },
      channels: { list: () => channels, subscribeList: () => () => {} },
    } as unknown as RelaySession;
    const view = render(
      <ActivityDetails
        session={session}
        selection={{ agent, channelId: "alpha", [mode]: "b".repeat(64) }}
      />,
    );
    try {
      expect(
        screen.getByText(/This host cannot decode agent activity/),
      ).toBeTruthy();
      expect(
        screen.queryByText(
          /No activity received|No activity is retained|send boundary/,
        ),
      ).toBeNull();
      expect(screen.queryByRole("combobox")).toBeNull();
    } finally {
      view.unmount();
      activity.dispose();
    }
  },
);

it.each([false, true])(
  "does not describe an interrupted empty feed as listening (selected=%s)",
  (selected) => {
    const activity = createAgentActivity(
      true,
      () => {},
      () => true,
    );
    const release = activity.queries.activate();
    activity.state({ status: "retrying", routes: [] });
    const profiles = new Map();
    const channels = { status: "ready", channels: [] };
    const session = {
      agentChoices: createAgentLibrary(undefined).queries,
      agentActivity: activity.queries,
      profiles: { snapshot: () => profiles, subscribe: () => () => {} },
      channels: { list: () => channels, subscribeList: () => () => {} },
      live: { retry() {} },
    } as unknown as RelaySession;
    const view = render(
      <ActivityDetails
        session={session}
        {...(selected ? { selection: { agent, channelId: "alpha" } } : {})}
      />,
    );
    try {
      expect(screen.getByText(/Feed: interrupted/)).toBeTruthy();
      expect(screen.queryByText(/Waiting for live records/)).toBeNull();
      act(() =>
        activity.state({
          status: "connected",
          routes: [{ id: "observer", status: "live", replay: "unknown" }],
        }),
      );
      expect(screen.getByText(/Waiting for live records/)).toBeTruthy();
    } finally {
      view.unmount();
      release();
      activity.dispose();
    }
  },
);

it("keeps profile identity primary, namesakes selectable and exact evidence disclosed without profile reads", async () => {
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
  const other = "b".repeat(64);
  const profiles = new Map([
    [
      agent,
      {
        name: "Blossom",
        picture: "https://fixture.test/avatar.png",
        isAgent: false,
      },
    ],
    [
      other,
      {
        name: "Blossom",
        picture: "https://fixture.test/other.png",
        isAgent: false,
      },
    ],
  ]);
  const channels = {
    status: "ready",
    channels: [
      { id: "alpha", name: "Same name" },
      { id: "beta", name: "Same name" },
    ],
  };
  const ensure = vi.fn();
  const media = vi.fn((url: string) => url);
  const session = {
    agentChoices: createAgentLibrary(undefined).queries,
    agentActivity: activity.queries,
    profiles: { snapshot: () => profiles, subscribe: () => () => {}, ensure },
    channels: { list: () => channels, subscribeList: () => () => {} },
    media,
    live: { retry() {} },
  } as unknown as RelaySession;
  let id = 0;
  const send = (author: string, channelId: string, turnId: string) =>
    act(() =>
      activity.receive(
        {
          id: (++id).toString(16).padStart(64, "0"),
          agent: author,
          createdAt: Math.floor(Date.now() / 1000),
          plaintext: JSON.stringify({
            kind: "turn_liveness",
            channelId,
            turnId,
            timestamp: new Date().toISOString(),
          }),
        },
        generation,
      ),
    );
  // An unobserved profile target stays pinned, even while a different agent works.
  send(other, "beta", "B");
  const view = render(
    <ActivityDetails
      session={session}
      selection={{ agent, channelId: "alpha" }}
    />,
    { reactStrictMode: true },
  );
  try {
    expect(screen.getByRole("heading", { name: "Blossom" })).toBeTruthy();
    expect(
      view.container
        .querySelector("[data-avatar-shape]")
        ?.getAttribute("data-avatar-shape"),
    ).toBe("circle");
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      "https://fixture.test/avatar.png",
    );
    expect(screen.getByText("Live activity, not saved history")).toBeTruthy();
    expect(
      screen.getByText(
        /Waiting for live records for this identity in this channel/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/1 working turn/)).toBeNull();
    expect(ensure).not.toHaveBeenCalled();
    const labels = publicKeyLabels([agent, other]);
    await user.click(screen.getByRole("combobox", { name: "Agent" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(
      expect.arrayContaining([
        `Blossom · ${labels.get(agent)}`,
        `Blossom · ${labels.get(other)}`,
      ]),
    );
    await user.click(
      screen.getByRole("option", { name: `Blossom · ${labels.get(other)}` }),
    );
    expect(
      screen.getByRole("combobox", { name: "Channel" }).textContent,
    ).toContain("alpha");
    expect(
      screen.getByText(
        /Waiting for live records for this identity in this channel/,
      ),
    ).toBeTruthy();
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      "https://fixture.test/other.png",
    );
    expect(
      view.container
        .querySelector("[data-avatar-shape]")
        ?.getAttribute("data-avatar-shape"),
    ).toBe("squircle");
    await user.click(screen.getByRole("combobox", { name: "Channel" }));
    await user.click(
      await screen.findByRole("option", { name: "Same name · beta" }),
    );
    expect(screen.getByText("1 working turn.")).toBeTruthy();
    expect(screen.getByText("Working", { exact: true })).toBeTruthy();
    const stream = screen.getByRole("region", { name: "Readable activity" });
    const exact = screen.getByRole("button", { name: "Exact identity" });
    expect(
      stream.compareDocumentPosition(exact) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await user.click(exact);
    expect(view.container.querySelector("code")?.textContent).toBe(other);
    await user.click(screen.getByRole("button", { name: "Raw events" }));
    expect(
      await screen.findByRole("button", { name: /turn_liveness/ }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "About this feed" }));
    expect(await screen.findByText(/RAM only/)).toBeTruthy();
    expect(ensure).not.toHaveBeenCalled();
    send(other, "beta", "C");
    expect(screen.getByText("2 working turns.")).toBeTruthy();
    act(() => activity.state({ status: "retrying", routes: [] }));
    expect(screen.getByText(/Status unknown for 2 turns/)).toBeTruthy();
  } finally {
    view.unmount();
    release();
    activity.dispose();
  }
});

it("profile Activity shows the full human request by default during work, but keeps peer messages collapsed", async () => {
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
  const viewer = "b".repeat(64),
    peer = "c".repeat(64);
  const body = `${"Human request context ".repeat(50)}END`;
  const profiles = new Map([
    [viewer, { name: "Teammate" }],
    [peer, { name: "Reviewer", isAgent: true as const }],
  ]);
  const channels = {
    status: "ready",
    channels: [{ id: "alpha", name: "test" }],
  };
  const session = {
    viewer,
    agentChoices: createAgentLibrary(undefined).queries,
    agentActivity: activity.queries,
    profiles: { snapshot: () => profiles, subscribe: () => () => {} },
    channels: { list: () => channels, subscribeList: () => () => {} },
    live: { retry() {} },
  } as unknown as RelaySession;
  let sequence = 0;
  const send = (kind: string, payload: unknown) =>
    activity.receive(
      {
        id: (++sequence).toString(16).padStart(64, "0"),
        agent,
        createdAt: Math.floor(Date.now() / 1000),
        plaintext: JSON.stringify({
          kind,
          seq: sequence,
          channelId: "alpha",
          turnId: "T",
          timestamp: new Date().toISOString(),
          payload,
        }),
      },
      generation,
    );
  send("turn_started", {});
  for (const [author, text] of [
    [viewer, body],
    [peer, "Private peer exchange"],
  ])
    send("acp_write", {
      method: "session/prompt",
      params: {
        prompt: [
          {
            type: "text",
            text: `<buzz-event type="@mention">\nEvent ID: ${"d".repeat(64)}\nChannel: alpha\nKind: 9\nFrom: Sender (hex: ${author})\nContent: ${text}\nTags: [["h","alpha"]]\n</buzz-event>`,
          },
        ],
      },
    });
  // More than five later entries must not slide the human context out of profile.
  for (let i = 0; i < 7; i++)
    send("acp_read", {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: `tool${i}`,
          title: `Read file ${i}`,
          status: "completed",
        },
      },
    });
  const view = render(
    <ActivityDetails
      session={session}
      selection={{ agent, channelId: "alpha", view: "profile" }}
    />,
    { reactStrictMode: true },
  );
  try {
    expect(screen.getByText(body)).toBeTruthy();
    expect(screen.queryByText("Private peer exchange")).toBeNull();
    const humanToggle = screen.getByRole("button", {
      name: "Teammate Reported incoming message",
    });
    fireEvent.click(humanToggle);
    act(() => send("turn_liveness", {}));
    expect(screen.queryByText(body)).toBeNull();
    fireEvent.click(humanToggle);
    expect(screen.getByText(body)).toBeTruthy();
  } finally {
    view.unmount();
    release();
    activity.dispose();
  }
});

it("embeds one fixed identity with one scope control and readiness-aware empty state", async () => {
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
  const live = {
    status: "connected" as const,
    routes: [
      { id: "observer", status: "live" as const, replay: "unknown" as const },
    ],
  };
  activity.state(live);
  const profiles = new Map([[agent, { name: "Blossom" }]]);
  const channels = {
    status: "ready",
    channels: [
      { id: "alpha-id", name: "test" },
      { id: "beta-id", name: "Other" },
    ],
  };
  const retry = vi.fn(() => activity.state(live));
  const ensure = vi.fn();
  const session = {
    agentChoices: createAgentLibrary(undefined).queries,
    agentActivity: activity.queries,
    profiles: { snapshot: () => profiles, subscribe: () => () => {}, ensure },
    channels: { list: () => channels, subscribeList: () => () => {} },
    live: { retry },
  } as unknown as RelaySession;
  const view = render(<button type="button">Activity tab fixture</button>, {
    reactStrictMode: true,
  });
  screen.getByRole("button", { name: "Activity tab fixture" }).focus();
  view.rerender(
    <>
      <button type="button">Activity tab fixture</button>
      <ActivityDetails
        session={session}
        selection={{ agent, channelId: "alpha-id", view: "profile" }}
      />
    </>,
  );
  let id = 0;
  const send = (author: string, channelId: string | null) =>
    act(() =>
      activity.receive(
        {
          id: (++id).toString(16).padStart(64, "0"),
          agent: author,
          createdAt: Math.floor(Date.now() / 1000),
          plaintext: JSON.stringify({
            kind: "turn_liveness",
            channelId,
            turnId: `T${id}`,
            timestamp: new Date().toISOString(),
          }),
        },
        generation,
      ),
    );
  try {
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Activity tab fixture" }),
    );
    expect(screen.queryByRole("heading", { name: "Blossom" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Agent" })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByLabelText("Activity channel").textContent).toBe("#test");
    expect(
      screen.queryByRole("group", { name: "Choose activity channel" }),
    ).toBeNull();
    expect(view.container.textContent).not.toContain("alpha-id");
    expect(screen.getByText("No activity captured yet")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(
      screen.queryByText(/0 working|Ended does not mean succeeded/),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "About this feed" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(
      screen.queryByText(/No fresh working|backfill|Observed agents/),
    ).toBeNull();
    act(() => activity.state({ status: "retrying", routes: [] }));
    expect(screen.queryByText("No activity captured yet")).toBeNull();
    expect(screen.getByText("Activity feed interrupted.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry live feed" }));
    expect(retry).toHaveBeenCalledOnce();
    send("b".repeat(64), "alpha-id");
    expect(screen.getByText("No activity captured yet")).toBeTruthy();
    send(agent, "beta-id");
    send(agent, null);
    expect(screen.queryByText("No activity captured yet")).toBeNull();
    expect(screen.getByLabelText("Activity channel").textContent).toBe(
      "#Other",
    );
    expect(
      screen.queryByRole("group", { name: "Choose activity channel" }),
    ).toBeNull();
    send(agent, "alpha-id");
    expect(screen.getByLabelText("Activity channel").textContent).toBe(
      "#Other",
    );
    // Existing selection survives arrival; the two-dot selected click advances.
    await user.click(
      screen.getByRole("button", { name: "Show #Other activity" }),
    );
    expect(screen.getByLabelText("Activity channel").textContent).toBe("#test");
    expect(screen.getByText("Working now")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Agent" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText(agent)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Raw events" }));
    expect(
      screen.getAllByRole("button", { name: /turn_liveness/ }),
    ).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "About this feed" }),
    ).toBeNull();
    expect(screen.getByText("Live activity · Not saved yet")).toBeTruthy();
    expect(ensure).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    release();
    activity.dispose();
  }
});

it("explains ended-only evidence after record eviction in the profile tab", () => {
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
  for (let id = 0; id < 201; id++)
    activity.receive(
      {
        id: (id + 1).toString(16).padStart(64, "0"),
        agent,
        createdAt: Math.floor(Date.now() / 1000),
        plaintext: JSON.stringify({
          kind: id === 0 ? "turn_completed" : "turn_liveness",
          channelId: id === 0 ? "alpha" : null,
          turnId: id === 0 ? "ended" : "other",
          timestamp: new Date().toISOString(),
        }),
      },
      generation,
    );
  const profiles = new Map();
  const channels = {
    status: "ready",
    channels: [
      { id: "alpha", name: "Same" },
      { id: "beta", name: "Same" },
    ],
  };
  const session = {
    agentChoices: createAgentLibrary(undefined).queries,
    agentActivity: activity.queries,
    profiles: { snapshot: () => profiles, subscribe: () => () => {} },
    channels: { list: () => channels, subscribeList: () => () => {} },
  } as unknown as RelaySession;
  const view = render(
    <ActivityDetails
      session={session}
      selection={{ agent, channelId: "alpha", view: "profile" }}
    />,
  );
  try {
    expect(
      screen.getByText(
        "Earlier work ended. Its activity details are no longer retained.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("No activity captured yet")).toBeNull();
    expect(screen.getByLabelText("Activity channel").textContent).toBe("#Same");
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText(/1 ended/)).toBeTruthy();
  } finally {
    view.unmount();
    release();
    activity.dispose();
  }
});

it("matches the old profile's evidence-first initialization and selected-channel fallback", async () => {
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
  let id = 0;
  const send = (channelId: string, kind = "turn_liveness") =>
    activity.receive(
      {
        id: (++id).toString(16).padStart(64, "0"),
        agent,
        createdAt: Math.floor(Date.now() / 1000),
        plaintext: JSON.stringify({
          kind,
          channelId,
          turnId: channelId,
          timestamp: new Date().toISOString(),
        }),
      },
      generation,
    );
  send("z");
  send("a");
  const profiles = new Map();
  const channels = {
    status: "ready",
    channels: [
      { id: "z", name: "Zeta" },
      { id: "a", name: "Alpha" },
    ],
  };
  const session = {
    agentChoices: createAgentLibrary(undefined).queries,
    agentActivity: activity.queries,
    profiles: { snapshot: () => profiles, subscribe: () => () => {} },
    channels: { list: () => channels, subscribeList: () => () => {} },
  } as unknown as RelaySession;
  const view = render(
    <ActivityDetails
      session={session}
      selection={{ agent, channelId: "z", view: "profile" }}
    />,
    { reactStrictMode: true },
  );
  try {
    // Originating channel is fallback only, not a choice made in the old preview.
    expect(screen.getByLabelText("Activity channel").textContent).toBe(
      "#Alpha",
    );
    const picker = screen.getByRole("group", {
      name: "Choose activity channel",
    });
    expect(
      within(picker)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Show #Zeta activity", "Show #Alpha activity"]);
    await user.click(
      screen.getByRole("button", { name: "Show #Zeta activity" }),
    );
    act(() => send("a"));
    expect(screen.getByLabelText("Activity channel").textContent).toBe("#Zeta");
    act(() => send("z", "turn_completed"));
    expect(screen.getByLabelText("Activity channel").textContent).toBe(
      "#Alpha",
    );
    expect(
      screen.queryByRole("group", { name: "Choose activity channel" }),
    ).toBeNull();
    act(() => activity.clear());
    expect(screen.getByLabelText("Activity channel").textContent).toBe("#Zeta");
  } finally {
    view.unmount();
    release();
    activity.dispose();
  }
});

it("retains working evidence when only diagnostic activity is readable", () => {
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
  activity.receive(
    {
      id: "d".repeat(64),
      agent,
      createdAt: Math.floor(Date.now() / 1000),
      plaintext: JSON.stringify({
        kind: "acp_read",
        turnId: "T",
        channelId: "alpha",
        timestamp: new Date().toISOString(),
        payload: {
          method: "session/update",
          params: { update: { sessionUpdate: "usage_update" } },
        },
      }),
    },
    generation,
  );
  const profiles = new Map([[agent, { name: "Rivet" }]]);
  const channels = {
    status: "ready",
    channels: [{ id: "alpha", name: "Alpha" }],
  };
  const session = {
    agentChoices: createAgentLibrary(undefined).queries,
    agentActivity: activity.queries,
    profiles: { snapshot: () => profiles, subscribe: () => () => {} },
    channels: { list: () => channels, subscribeList: () => () => {} },
    live: { retry() {} },
  } as unknown as RelaySession;
  const view = render(
    <ActivityDetails
      session={session}
      selection={{ agent, channelId: "alpha" }}
    />,
  );
  try {
    const stream = screen.getByRole("region", { name: "Readable activity" });
    expect(within(stream).queryByText("Working", { exact: true })).toBeNull();
    expect(screen.getByText("1 working turn.").getAttribute("role")).toBe(
      "status",
    );
    expect(
      within(stream).getByRole("button", { name: "Diagnostics (1)" }),
    ).toBeTruthy();
  } finally {
    view.unmount();
    release();
    activity.dispose();
  }
});

it("keeps an expanded reply fixed to its exact author and never falls back to a peer after evidence disappears", () => {
  const other = "b".repeat(64),
    root = "c".repeat(64),
    viewer = "d".repeat(64);
  let generation = 0,
    serial = 0;
  const activity = createAgentActivity(
    true,
    (g) => {
      generation = g ?? 0;
    },
    () => true,
  );
  const release = activity.queries.activate();
  activity.state({
    status: "connected",
    routes: [{ id: "observer", status: "live", replay: "unknown" }],
  });
  const profiles = new Map([
    [agent, { name: "Same" }],
    [other, { name: "Same" }],
  ]);
  const channels = {
    status: "ready",
    channels: [{ id: "alpha", name: "Alpha" }],
  };
  const session = {
    viewer,
    agentChoices: createAgentLibrary(undefined).queries,
    agentActivity: activity.queries,
    profiles: { snapshot: () => profiles, subscribe: () => () => {} },
    channels: { list: () => channels, subscribeList: () => () => {} },
    live: { retry() {} },
  } as unknown as RelaySession;
  const views = createThreadViews();
  const request: ChannelMessage = {
    id: root,
    channelId: "alpha",
    authorId: viewer,
    content: "request",
    createdAt: 1,
    mentions: [agent, other],
    participants: [],
    replyCount: 0,
    attachments: [],
    reactions: [],
  };
  const thread: ThreadSnapshot = {
    root: request,
    replies: [],
    status: "ready",
    error: undefined,
    limited: false,
    canLoadMore: false,
  };
  const unregister = views.register(session, "alpha", {
    snapshot: () => thread,
    subscribe: () => () => {},
    refresh: vi.fn(),
    loadMore: vi.fn(),
    dispose: vi.fn(),
  });
  const emit = (key: string) => {
    for (const [seq, kind, payload] of [
      [1, "turn_started", { triggeringEventIds: [root] }],
      [
        2,
        "acp_read",
        {
          method: "session/update",
          params: {
            sessionId: "S",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool",
              title: "buzz-dev-mcp__shell",
              status: "in_progress",
              rawInput: {
                command:
                  key === agent ? "python3 author.py" : "python3 peer.py",
              },
            },
          },
        },
      ],
    ] as const)
      activity.receive(
        {
          id: String(++serial).padStart(64, "0"),
          agent: key,
          createdAt: Math.floor(Date.now() / 1000),
          plaintext: JSON.stringify({
            kind,
            seq,
            turnId: key,
            sessionId: "S",
            channelId: "alpha",
            timestamp: new Date().toISOString(),
            payload,
          }),
        },
        generation,
      );
  };
  emit(agent);
  emit(other);
  const content = (fixed: boolean) => (
    <ThreadViews value={views}>
      <ActivityDetails
        session={session}
        selection={{
          agent,
          channelId: "alpha",
          requestId: root,
          threadRootId: root,
          ...(fixed ? { view: "agent" as const } : {}),
        }}
      />
    </ThreadViews>
  );
  const rendered = render(content(true), { reactStrictMode: true });
  try {
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("button", { name: /author.py/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /peer.py/ })).toBeNull();
    act(() => {
      activity.clear();
      activity.state({
        status: "connected",
        routes: [{ id: "observer", status: "live", replay: "unknown" }],
      });
      emit(other);
    });
    expect(
      screen.queryByRole("button", { name: /author.py|peer.py/ }),
    ).toBeNull();
    expect(
      screen.getByText("No retained work is linked to this request yet."),
    ).toBeTruthy();
    rendered.rerender(content(false));
    expect(screen.getByRole("button", { name: /peer.py/ })).toBeTruthy();
  } finally {
    rendered.unmount();
    unregister();
    release();
    activity.dispose();
  }
});
