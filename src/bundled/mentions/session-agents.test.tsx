// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import type { RelaySession } from "../../features/relay/session";
import { MentionPicker } from "./MentionPicker";
import { MentionCompletion } from "./MentionCompletion";
import { createAgentChoices } from "../../features/agents/choices";
import { createAgentLibrary } from "../../features/agents/library";
import type { CompletionResult } from "../../features/conversation/contracts";
import { bindNames } from "../../features/identity-names/service";
import { createAgentDirectory } from "../agents/directory";
import type {
  AgentControlState,
  AgentView,
} from "../../features/agents/control";
import {
  followupDraft,
  type MentionRecipient,
} from "../../features/messages/mention-draft";
import { createMessages } from "../../features/relay/messages";
import type { Outbox } from "../../features/relay/outbox";
import { MessageMarkdown } from "../../features/messages/MessageMarkdown";
import { profileTarget } from "../../features/profiles/target";
afterEach(cleanup);
function setup(parent: boolean | null = true) {
  const key = "b".repeat(64),
    member = "a".repeat(64);
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: [{ pubkey: key, name: "Outside agent" }],
  }));
  const list = {
    status: "ready",
    channels:
      parent === null
        ? []
        : [
            {
              id: "parent",
              channelType: parent ? "stream" : "session",
              members: [member],
            },
          ],
  };
  const profiles = new Map([[member, { name: "Member" }]]);
  const session = {
    channels: {
      list: () => list,
      subscribeList: () => () => {},
      ensureList: () => {},
    },
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    names: {
      subscribe: () => () => {},
      snapshot: () => 0,
      resolve: (_key: string, fallback: string) => fallback,
    },
    agentLibrary: library.queries,
    agentChoices: createAgentChoices({
      scope: "test",
      library: library.queries,
      signal: new AbortController().signal,
    }),
    media: () => undefined,
  } as unknown as RelaySession;
  return { session, library, key };
}
it("uses the same alphabetical and prefix ordering for typed and button mentions", async () => {
  const test = setup();
  const keys = ["c", "d", "e"].map((key) => key.repeat(64));
  const names = ["Zoe", "Adam Avery", "Avery"];
  const profiles = new Map(
    keys.map((key, index) => [key, { name: names[index] ?? key }]),
  );
  const list: ReturnType<RelaySession["channels"]["list"]> = {
    status: "ready",
    channels: [
      { id: "parent", name: "Parent", channelType: "stream", members: keys },
    ],
  };
  const session = {
    ...test.session,
    channels: { ...test.session.channels, list: () => list },
    profiles: { ...test.session.profiles, snapshot: () => profiles },
  } satisfies RelaySession;
  const publish = vi.fn();
  const props = {
    session,
    scope: "test",
    channelId: "parent",
    observation: { revision: 1, text: "@", start: 1, end: 1 },
    query: { start: 0, end: 1, query: "" },
    publish,
  };
  const view = render(<MentionCompletion {...props} />);
  const completionNames = () =>
    (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items.map(
      (item) => item.label,
    );
  expect(completionNames()).toEqual(["Adam Avery", "Avery", "Zoe"]);
  view.rerender(
    <MentionCompletion
      {...props}
      query={{ start: 0, end: 6, query: "avery" }}
    />,
  );
  expect(completionNames()).toEqual(["Avery", "Adam Avery"]);
  view.unmount();
  render(
    <MentionPicker
      session={session}
      scope="test"
      channelId="parent"
      disabled={false}
      select={() => true}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  const pickerNames = () =>
    screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"))
      .filter((label) => keys.some((key) => label?.endsWith(key)))
      .map((label) => label?.slice(0, -65));
  expect(pickerNames()).toEqual(["Adam Avery", "Avery", "Zoe"]);
  await user.type(screen.getByRole("searchbox"), "avery");
  expect(pickerNames()).toEqual(["Avery", "Adam Avery"]);
  test.library.dispose();
});
it("offers outside agents in the session mention picker while ordinary channel pickers keep their roster", async () => {
  const test = setup(),
    user = userEvent.setup(),
    select = vi.fn(() => true);
  const view = render(
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled={false}
      select={select}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  expect(
    screen.queryByRole("button", { name: `Outside agent ${test.key}` }),
  ).not.toBeInTheDocument();
  view.rerender(
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled={false}
      inviteAgents
      select={select}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: `Outside agent ${test.key}` }),
  );
  expect(select).toHaveBeenCalledWith({
    pubkey: test.key,
    name: "Outside agent",
  });
  view.unmount();
  test.library.dispose();
});
it.each([true, false, null])(
  "typed @ completion offers outside agents with correct admission: parent=%s",
  async (parent) => {
    const test = setup(parent);
    let result: CompletionResult | undefined;
    const publish = vi.fn((next: CompletionResult) => {
      result = next;
      return () => {};
    });
    const props = {
      session: test.session,
      scope: "test",
      channelId: "parent",
      observation: { revision: 1, text: "@Outside", start: 8, end: 8 },
      query: { start: 0, end: 8, query: "Outside" },
      publish,
    };
    const view = render(<MentionCompletion {...props} inviteAgents />);
    await waitFor(() =>
      expect(result?.items).toEqual([
        expect.objectContaining({
          id: test.key,
          detail: expect.stringContaining(
            parent ? "Adds to session and parent channel" : "Adds to session ·",
          ),
          edit: { mention: { pubkey: test.key, name: "Outside agent" } },
        }),
      ]),
    );
    if (parent === null) {
      expect(result?.status).toBeUndefined();
      expect(result?.retry).toBeUndefined();
    }
    view.rerender(<MentionCompletion {...props} />);
    await waitFor(() => expect(result?.items).toHaveLength(0));
    view.unmount();
    test.library.dispose();
  },
);

// Exercise selection, wire text/p tags, and sent rendering, not an already-bound @name.
it.each(["picker", "completion"] as const)(
  "%s keeps native display labels out of serialized mentions",
  async (surface) => {
    const test = setup();
    const profiles = new Map([[test.key, { name: "Mic" }]]);
    const library = createAgentLibrary(async () => ({
      definitions: [],
      identities: [{ pubkey: test.key, name: "Legacy Mic" }],
    }));
    let state: AgentControlState = {
      status: "ready",
      busy: false,
      error: null,
      data: {
        runtimeAvailable: true,
        agents: [
          {
            pubkey: test.key,
            relayUrl: "wss://here.example",
            name: "Native Mic",
          } as AgentView,
        ],
      },
    };
    const listeners = new Set<() => void>();
    const provider = createAgentDirectory({
      snapshot: () => state,
      refresh: async () => {},
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
    const session = {
      ...test.session,
      agentLibrary: library.queries,
      agentChoices: createAgentChoices({
        scope: "test",
        library: library.queries,
        signal: new AbortController().signal,
      }),
      profiles: { ...test.session.profiles, snapshot: () => profiles },
    };
    const names = bindNames(
      { ...session, relayUrl: "wss://here.example" },
      {
        snapshot: () => [provider],
        subscribe: () => () => {},
      },
    );
    session.names = names;
    const user = userEvent.setup();
    let selected: MentionRecipient | undefined;
    let result: CompletionResult | undefined;
    const select = (recipient: MentionRecipient) => {
      selected = recipient;
      return true;
    };
    const publish = (next: CompletionResult) => {
      result = next;
      return () => {};
    };
    try {
      const menu = render(
        surface === "picker" ? (
          <MentionPicker
            scope="test"
            session={session}
            channelId="parent"
            disabled={false}
            inviteAgents
            select={select}
          />
        ) : (
          <MentionCompletion
            session={session}
            scope="test"
            channelId="parent"
            inviteAgents
            observation={{ revision: 1, text: "@Native", start: 7, end: 7 }}
            query={{ start: 0, end: 7, query: "Native" }}
            publish={publish}
          />
        ),
      );
      if (surface === "picker") {
        await user.click(
          screen.getByRole("button", { name: "Mention a member" }),
        );
        await user.click(
          await screen.findByRole("button", { name: `Native Mic ${test.key}` }),
        );
      } else {
        await waitFor(() => expect(result?.items[0]?.label).toBe("Native Mic"));
        const edit = result?.items[0]?.edit;
        if (!edit || !("mention" in edit))
          throw new Error("Missing mention choice");
        select(edit.mention);
      }
      menu.unmount();
      if (!selected) throw new Error("No selected recipient");
      expect(selected).toEqual({ pubkey: test.key, name: "Legacy Mic" });
      const draft = followupDraft([selected]);
      const send = vi.fn<Outbox["send"]>(() => "sent");
      const messages = createMessages(
        { supports: () => true, send } as unknown as Outbox,
        "viewer",
        () => undefined,
        () => [],
        () => {},
      );
      messages.send(
        "parent",
        draft.text,
        draft.recipients.map((item) => item.pubkey),
      );
      const wire = send.mock.calls[0]?.[0];
      if (!wire) throw new Error("No outgoing message");
      expect(wire).toEqual({
        kind: 9,
        content: "@Legacy Mic",
        tags: [
          ["h", "parent"],
          ["p", test.key],
        ],
      });
      const open = vi.fn(() => true);
      const view = render(
        <MessageMarkdown
          session={session}
          row={{
            id: "sent",
            channelId: "parent",
            authorId: "viewer",
            content: wire.content,
            createdAt: 1,
            mentions: wire.tags
              .filter(([tag]) => tag === "p")
              .map(([, key]) => key ?? ""),
            participants: [],
            attachments: [],
            reactions: [],
            replyCount: 0,
          }}
          participantProfiles={profiles}
          directory={{
            profiles,
            channels: [],
            agents: library.queries.snapshot().identities,
          }}
          media={() => undefined}
          onOpenLink={open}
          canOpenLink={() => true}
        />,
      );
      const button = screen.getByRole("button", {
        name: "View Native Mic profile",
      });
      act(() => {
        const data = state.data;
        const agent = data?.agents[0];
        if (!data || !agent) throw new Error("Missing native agent");
        state = {
          ...state,
          data: {
            ...data,
            agents: [{ ...agent, name: "Renamed Mic" }],
          },
        };
        for (const listener of listeners) listener();
      });
      expect(
        screen.getByRole("button", { name: "View Renamed Mic profile" }),
      ).toBe(button);
      await user.click(button);
      expect(open).toHaveBeenCalledWith(profileTarget(test.key));
      view.unmount();
    } finally {
      names.dispose();
      library.dispose();
      test.library.dispose();
    }
  },
);

// Component lifecycle demand, not browser geometry: real source capabilities and
// remounts reproduce completion producers being replaced as the query changes.
it.each([false, true])(
  "completion remounts preserve warm evidence (invite=%s)",
  async (inviteAgents) => {
    const test = setup();
    const f = controlFixture();
    const native = createAgentControl(f.host);
    const read = vi.fn(async () => ({
      definitions: [],
      identities: [{ pubkey: test.key, name: "Outside agent" }],
    }));
    const library = createAgentLibrary(read);
    const lifetime = new AbortController();
    const session = {
      ...test.session,
      agentChoices: createAgentChoices({
        scope: `https://relay.example.test:${"aa".repeat(32)}`,
        library: library.queries,
        native,
        signal: lifetime.signal,
      }),
    };
    let result: CompletionResult | undefined;
    const props = {
      session,
      scope: "test",
      channelId: "parent",
      inviteAgents,
      observation: { revision: 1, text: "@Outside", start: 8, end: 8 },
      query: { start: 0, end: 8, query: "Outside" },
      publish: (next: CompletionResult) => {
        result = next;
        return () => {};
      },
    };
    const tree = (key: number) => (
      <StrictMode>
        <MentionCompletion key={key} {...props} />
      </StrictMode>
    );
    const view = render(tree(0));
    try {
      await waitFor(() => expect(native.snapshot().status).toBe("ready"));
      if (inviteAgents)
        await waitFor(() => expect(result?.items).toHaveLength(1));
      expect(read).toHaveBeenCalledTimes(inviteAgents ? 1 : 0);
      const warm = session.agentChoices.snapshot();
      for (let key = 1; key <= 3; key++) {
        view.rerender(tree(key));
        await act(async () => {});
        expect(session.agentChoices.snapshot()).toBe(warm);
        expect(read).toHaveBeenCalledTimes(inviteAgents ? 1 : 0);
        expect(
          f.calls.filter((call) => call.action === "snapshot"),
        ).toHaveLength(1);
      }
      // An explicit library change still reaches an ordinary open completion.
      await act(async () => {
        await library.queries.refresh();
      });
      expect(session.agentChoices.snapshot().identities).toContainEqual(
        expect.objectContaining({ pubkey: test.key }),
      );
      expect(read).toHaveBeenCalledTimes(inviteAgents ? 2 : 1);
    } finally {
      view.unmount();
      lifetime.abort();
      library.dispose();
      test.library.dispose();
      native.dispose();
    }
  },
);

it("opening and reopening an ordinary picker does not load the legacy library", async () => {
  const test = setup();
  const user = userEvent.setup();
  const view = render(
    <MentionPicker
      scope="test"
      session={test.session}
      channelId="parent"
      disabled={false}
      select={() => true}
    />,
  );
  try {
    for (let i = 0; i < 3; i++) {
      await user.click(
        screen.getByRole("button", { name: "Mention a member" }),
      );
      expect(test.library.queries.snapshot().status).toBe("idle");
    }
  } finally {
    view.unmount();
    test.library.dispose();
  }
});

it("selects the exact recipient behind a context-aware owner label", async () => {
  const test = setup();
  const viewer = "1".repeat(64),
    owner = "2".repeat(64),
    mine = "c".repeat(64);
  const profiles = new Map([
    [viewer, { name: "Logan" }],
    [owner, { name: "Wes" }],
    [mine, { name: "Honey", isAgent: true as const, ownerPubkey: viewer }],
    [test.key, { name: "Honey", isAgent: true as const, ownerPubkey: owner }],
  ]);
  const list = {
    status: "ready" as const,
    channels: [{ id: "parent", name: "Parent", members: [mine, test.key] }],
  };
  const session = {
    ...test.session,
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    channels: { ...test.session.channels, list: () => list },
  };
  const provider = createAgentDirectory();
  const library = createAgentLibrary(undefined);
  const names = bindNames(
    { viewer, profiles: session.profiles, agentLibrary: library.queries },
    { snapshot: () => [provider], subscribe: () => () => {} },
  );
  const select = vi.fn(() => true);
  const view = render(
    <MentionPicker
      scope="scope"
      session={{ ...session, names }}
      channelId="parent"
      disabled={false}
      select={select}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  await user.click(
    await screen.findByRole("button", { name: `Wes’s Honey ${test.key}` }),
  );
  expect(select).toHaveBeenCalledWith({ pubkey: test.key, name: "Honey" });
  view.unmount();
  names.dispose();
  library.dispose();
  test.library.dispose();
});
