// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
stubAvatarBrowserApis();
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRef } from "react";
import { Context } from "@deepseek-ai/cordis";
import userEvent from "@testing-library/user-event";
import { PluginRuntime } from "../../plugins/runtime";
import { createRelaySession } from "../relay/session";
import { keypair, signed, scriptedTransport } from "../relay/testing";
import type { LiveCallbacks } from "../relay/live";
import { MentionPicker } from "../../bundled/mentions/MentionPicker";
import { bindNames, IdentityNamesService } from "./service";
import { createAgentDirectory, defaultNamingPolicy } from "./testing";
import type { RelaySession } from "../relay/session";
import type { PresenceStatus } from "../presence/presence";
import { BuzzLinkPreview } from "../conversation/BuzzLinkPreview";
import { ActivityAccessory } from "../../bundled/agent-activity/ActivityAccessory";
import { SearchResults } from "../../app/shell/SearchResults";
import { useChannelLabels } from "../../bundled/channels/useChannelLabels";
import { AgentChoice } from "../sessions/AgentChoice";
import { MessageRow } from "../messages/MessageRow";
import type { ChannelMessage } from "../relay/contracts";
const a = "a".repeat(64),
  b = "b".repeat(64);
const stops: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
function fixture() {
  const listeners = new Set<() => void>();
  let presenceStatus: PresenceStatus = "unknown";
  const profiles = new Map([
    [a, { name: "Larry", isAgent: true as const }],
    [b, { name: "Larry", isAgent: true as const }],
  ]);
  let channel = {
    id: "c",
    name: "DM",
    channelType: "dm" as const,
    members: [a],
    participants: [a],
  };
  let list = { status: "ready" as const, channels: [channel] };
  const rows = [{ pubkey: a, name: "Larry" }];
  const library = {
    status: "ready",
    identities: rows,
    selectable: rows,
    definitions: [],
    archives: { status: "unavailable" as const, archived: [] },
  };
  const message = {
    id: "m",
    channelId: "c",
    authorId: a,
    content: "hello",
    createdAt: 1,
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
  };
  const thread = {
    status: "ready",
    root: message,
    replies: [],
    canLoadMore: false,
  };
  const activity = {
    status: "ready",
    records: [],
    turns: [],
    typing: [{ channelId: "c", agent: a }],
    trimmed: 0,
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const session = {
    presence: {
      status: () => presenceStatus,
      limited: () => false,
      subscribe: (_pubkey: string, listener: () => void) => subscribe(listener),
    },
    profiles: { snapshot: () => profiles, subscribe, ensure: async () => {} },
    channels: {
      list: () => list,
      subscribeList: subscribe,
      ensureList() {},
      get: () => channel,
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe,
      retain: () => () => {},
      refresh: async () => {},
    },
    agentChoices: {
      snapshot: () => library,
      subscribe,
      retain: () => () => {},
      ensure() {},
      refresh: async () => {},
    },
    agentActivity: { snapshot: () => activity, subscribe },
    thread: () => ({
      snapshot: () => thread,
      subscribe,
      refresh: async () => {},
      dispose() {},
    }),
    media: () => undefined,
    read: async () => [
      {
        id: "m",
        kind: 9,
        pubkey: a,
        created_at: 1,
        content: "hello",
        tags: [["h", "c"]],
      },
    ],
  } as unknown as RelaySession;
  const names = bindNames(session, {
    snapshot: () => [createAgentDirectory()],
    subscribe: () => () => {},
  });
  stops.push(() => names.dispose());
  return {
    session: { ...session, names },
    setPresence(status: PresenceStatus) {
      presenceStatus = status;
      for (const listener of listeners) listener();
    },
    join() {
      channel = { ...channel, members: [a, b], participants: [a, b] };
      list = { ...list, channels: [channel] };
      for (const listener of listeners) listener();
    },
  };
}
it("refreshes message, DM, and mention labels from a live renamed agent profile", async () => {
  const viewer = keypair();
  const relay = keypair();
  const agent = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live: LiveCallbacks | undefined;
  const ctx = new Context();
  const runtime = new PluginRuntime(ctx, async () => ({
    inject: ["identityNames"],
    apply: (scope) => scope.identityNames.register(defaultNamingPolicy),
  }));
  const identityNames = new IdentityNamesService(ctx);
  runtime.reconcile([
    {
      manifest: { id: "test.agent-names", name: "Agent names", apiVersion: 1 },
      source: "bundled",
      enabled: true,
      reloadable: false,
      revision: "one",
      previous: null,
      error: null,
    },
  ]);
  const writeProfile = (name: string, createdAt: number) =>
    signed(agent, {
      kind: 0,
      created_at: createdAt,
      content: JSON.stringify({ name }),
      tags: [["auth", viewer.pubkey, "", "d".repeat(128)]],
    });
  let relayProfile = writeProfile("GLM", 1_700_000_000);
  const owner = createRelaySession(
    {
      ...wire.transport,
      query: async (filters) =>
        filters.some((filter) => filter.kinds?.includes(30175))
          ? []
          : filters.some((filter) => filter.kinds?.includes(0))
            ? [relayProfile]
            : [],
      readAgentLibrary: async () => ({
        definitions: [],
        identities: [{ pubkey: agent.pubkey, name: "GLM" }],
      }),
      scope: "wss://relay.example",
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { identityNames },
  );
  const stream = {
    id: "channel",
    name: "general",
    channelType: "stream" as const,
    members: [agent.pubkey],
    participants: [],
  };
  const dm = {
    id: "dm",
    name: "DM",
    channelType: "dm" as const,
    members: [viewer.pubkey, agent.pubkey],
    participants: [agent.pubkey],
  };
  const roster = { status: "ready" as const, channels: [stream, dm] };
  const channels = {
    ...owner.session.channels,
    list: () => roster,
    subscribeList: () => () => {},
    ensureList() {},
    get: (id: string) => [stream, dm].find((channel) => channel.id === id),
  };
  const session = { ...owner.session, channels } as RelaySession;
  try {
    await vi.waitFor(() =>
      expect(session.agentLibrary.snapshot().status).toBe("ready"),
    );
    if (!live) throw new Error("Relay live subscription was not installed");
    act(() => live?.receive([writeProfile("GLM", 1_700_000_000)]));

    function Sidebar() {
      const labels = useChannelLabels([dm], session.profiles, session.names);
      return <output aria-label="DM label">{labels.channels[0]?.name}</output>;
    }
    const row: ChannelMessage = {
      id: "message",
      channelId: stream.id,
      authorId: agent.pubkey,
      content: "hello",
      createdAt: 1_700_000_000,
      mentions: [],
      participants: [],
      attachments: [],
      reactions: [],
      replyCount: 0,
    };
    const view = render(
      <>
        <Sidebar />
        <MessageRow
          row={row}
          session={session}
          profile={session.profiles.snapshot().get(agent.pubkey)}
          media={() => undefined}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
        />
        <MentionPicker
          session={session}
          scope="test"
          channelId={stream.id}
          disabled={false}
          inviteAgents
          select={() => true}
        />
      </>,
    );
    expect(screen.getByLabelText("DM label")).toHaveTextContent("GLM");
    expect(
      view.container.querySelector('[data-message-id="message"]'),
    ).toHaveTextContent("GLM");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Mention a member" }));
    expect(
      await screen.findByRole("button", { name: `GLM ${agent.pubkey}` }),
    ).toBeVisible();

    act(() => {
      relayProfile = writeProfile("Luna", 1_700_000_001);
      live?.receive([relayProfile]);
    });
    await vi.waitFor(() => {
      expect(screen.getByLabelText("DM label")).toHaveTextContent("Luna");
      expect(
        view.container.querySelector('[data-message-id="message"]'),
      ).toHaveTextContent("Luna");
      expect(
        screen.getByRole("button", { name: `Luna ${agent.pubkey}` }),
      ).toBeVisible();
    });
    expect(
      screen.queryByRole("button", { name: `GLM ${agent.pubkey}` }),
    ).not.toBeInTheDocument();
  } finally {
    owner.dispose();
    await runtime.dispose();
    await ctx.fiber.dispose();
  }
});
it("uses channel scope in link previews and activity, and participant scope in sidebar DMs", async () => {
  const f = fixture();
  function Sidebar() {
    const labels = useChannelLabels(
      f.session.channels.list().channels,
      f.session.profiles,
      f.session.names,
    );
    return <output aria-label="DM label">{labels.channels[0]?.name}</output>;
  }
  const view = render(
    <>
      <Sidebar />
      <BuzzLinkPreview session={f.session} channelId="c" messageId="m" />
      <ActivityAccessory
        session={f.session}
        scope="test"
        channelId="c"
        canOpen={() => true}
        open={() => true}
      />
    </>,
  );
  await userEvent
    .setup()
    .click(screen.getByText("Channel-wide activity · 1 agent"));
  expect(view.container.querySelector("strong")).toHaveTextContent("Larry");
  expect(screen.getByLabelText("DM label")).toHaveTextContent(/^Larry$/);
  expect(
    screen.getByRole("button", {
      name: `View activity for Larry ${a.slice(0, 12)}`,
    }),
  ).toBeVisible();
  act(() => f.setPresence("away"));
  expect(
    screen.getByRole("button", {
      name: `View activity for Larry ${a.slice(0, 12)}, Presence: away`,
    }),
  ).toBeVisible();
  act(() => f.join());
  expect(view.container.querySelector("strong")).toHaveTextContent(
    "Larry · rcaj",
  );
  expect(screen.getByLabelText("DM label")).toHaveTextContent(
    "Larry · rcaj, Larry · 04hu",
  );
  expect(
    screen.getByRole("button", {
      name: `View activity for Larry · rcaj ${a.slice(0, 12)}, Presence: away`,
    }),
  ).toBeVisible();
});
it("scopes search DM labels and message authors to their own conversation", async () => {
  // jsdom lacks scrollIntoView; the palette reveals its typed-text selection.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const f = fixture();
  render(
    <SearchResults
      session={f.session}
      query="hello"
      onQueryChange={() => {}}
      input={createRef()}
      pages={[]}
      openConversation={() => {}}
    />,
  );
  expect(
    await screen.findByRole("option", { name: /hello.*Larry · Larry/ }),
  ).toBeVisible();
  act(() => f.join());
  expect(
    screen.getByRole("option", {
      name: /hello.*Larry · rcaj, Larry · 04hu · Larry · rcaj/,
    }),
  ).toBeVisible();
});
it("keeps a unique selectable agent plain despite a cached namesake", async () => {
  const f = fixture();
  const change = vi.fn();
  render(<AgentChoice session={f.session} value={a} onChange={change} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Change agent: Larry" }));
  await user.click(await screen.findByRole("menuitemradio", { name: "Larry" }));
  expect(change).toHaveBeenCalledWith(a, expect.anything());
});
