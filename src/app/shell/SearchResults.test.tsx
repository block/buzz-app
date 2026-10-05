// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { type Filter, matchFilter } from "nostr-tools";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { ReadError } from "../../features/relay/errors";
import {
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "../../features/relay/testing";
import type { LiveCallbacks } from "../../features/relay/live";
import { SearchResults } from "./SearchResults";
import { readSearchUsage, recordChoice, recordVisit } from "./search-usage";
import { ChatCircleIcon } from "../../shared/design-system/icons/index";

// jsdom lacks scrollIntoView; the palette reveals its typed-text selection.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("opens with a conversation action and recent channels in activity order", async () => {
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "older", "older", 1700000000),
    roster(relay, "older", [viewer.pubkey]),
    metadata(relay, "latest", "latest", 1700000100),
    roster(relay, "latest", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const changeScope = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query=""
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        currentChannelId="older"
        onScopeChange={changeScope}
        openConversation={() => {}}
      />,
    );
    const action = await screen.findByRole("option", {
      name: /Search in older/,
    });
    const recent = within(
      screen.getByRole("group", { name: "Recent activity" }),
    );
    const [first, second] = recent.getAllByRole("option");
    expect(first).toHaveTextContent("latest");
    expect(second).toHaveTextContent("older");
    fireEvent.click(action);
    expect(changeScope).toHaveBeenCalledExactlyOnceWith("older");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("ranks typed channel names and selects the best one for Enter", async () => {
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  // Weak matches come first in list order and exceed the eight-row limit.
  const names = [
    ...Array.from({ length: 8 }, (_, index) => `xlar-${index}`),
    "the-lar",
    "lar-crew",
    "lar",
  ];
  const discovery = names.flatMap((name, index) => [
    metadata(relay, name, name, 1700000000 + index),
    roster(relay, name, [viewer.pubkey]),
  ]);
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const open = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="lar"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        currentChannelId="xlar-0"
        onScopeChange={() => {}}
        openConversation={open}
      />,
    );
    const channels = await screen.findByRole("group", { name: "Channels" });
    await waitFor(() =>
      expect(within(channels).getAllByRole("option")).toHaveLength(8),
    );
    expect(
      within(channels)
        .getAllByRole("option")
        .slice(0, 4)
        .map((option) => option.textContent),
    ).toEqual([
      expect.stringMatching(/^lar/),
      expect.stringMatching(/^lar-crew/),
      expect.stringMatching(/^the-lar/),
      expect.stringMatching(/^xlar-/),
    ]);
    // The scope action follows named results, so it is not selected first.
    const groups = screen
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label"));
    expect(groups.indexOf("This conversation")).toBeGreaterThan(
      groups.indexOf("Channels"),
    );
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      within(channels).getAllByRole("option")[0]?.id,
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(open).toHaveBeenCalledExactlyOnceWith("lar");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("fuzzy-matches channel names after substring matches, word starts first", async () => {
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const names = [
    "big-grape",
    "buzz-github-prs",
    "debug-pr",
    "general",
    "ops-bgp",
  ];
  const discovery = names.flatMap((name, index) => [
    metadata(relay, name, name, 1700000000 + index),
    roster(relay, name, [viewer.pubkey]),
  ]);
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const open = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="bgp"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={open}
      />,
    );
    const channels = await screen.findByRole("group", { name: "Channels" });
    // The substring match leads. Initials ("b"uzz-"g"ithub-"p"rs) come next,
    // then names that merely hold the letters in order. "general" has no "b".
    await waitFor(() =>
      expect(
        within(channels)
          .getAllByRole("option")
          .map((option) => option.textContent?.split(/[A-Z]/)[0]),
      ).toEqual([
        "ops-bgp",
        "buzz-github-prs",
        expect.stringMatching(/^(big-grape|debug-pr)$/),
        expect.stringMatching(/^(big-grape|debug-pr)$/),
      ]),
    );
    // The matched letters are underlined, and only those letters.
    const marks = (name: string) =>
      [
        ...within(channels)
          .getByRole("option", { name: new RegExp(`^${name}`) })
          .querySelectorAll("mark"),
      ].map((mark) => mark.textContent);
    expect(marks("ops-bgp")).toEqual(["bgp"]);
    expect(marks("buzz-github-prs")).toEqual(["b", "g", "p"]);
    expect(marks("debug-pr")).toEqual(["b", "g", "p"]);
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(open).toHaveBeenCalledExactlyOnceWith("ops-bgp");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("leads with the group holding the best match and ranks archived channels after live ties", async () => {
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "space", "team-workspace", 1700000000),
    roster(relay, "space", [viewer.pubkey]),
    signed(relay, {
      kind: 39000,
      created_at: 1700000001,
      content: "",
      tags: [
        ["d", "old"],
        ["t", "stream"],
        ["name", "work-old"],
        ["archived", "true"],
      ],
    }),
    roster(relay, "old", [viewer.pubkey]),
    metadata(relay, "log", "work-log", 1700000002),
    roster(relay, "log", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      return discovery.filter((event) =>
        filters.some((filter) => filter.kinds?.includes(event.kind)),
      );
    },
  });
  const work = vi.fn();
  const page = (label: string, run = () => {}) => ({
    key: label,
    label,
    icon: ChatCircleIcon,
    run,
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="work"
        onQueryChange={() => {}}
        input={createRef()}
        // PageSearch ranks pages before they arrive here.
        pages={[page("Work", work), page("Workflows")]}
        openConversation={() => {}}
      />,
    );
    const channels = await screen.findByRole("group", { name: "Channels" });
    await waitFor(() =>
      expect(within(channels).getAllByRole("option")).toHaveLength(3),
    );
    expect(
      within(channels)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      expect.stringMatching(/^work-log/),
      expect.stringMatching(/^work-old/),
      expect.stringMatching(/^team-workspace/),
    ]);
    const groups = screen
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label"));
    expect(groups.slice(0, 2)).toEqual(["Pages", "Channels"]);
    const pages = screen.getByRole("group", { name: "Pages" });
    expect(
      within(pages)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Work", "Workflows"]);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    expect(work).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("shows the real read failure, retains conversation choices, and retries to an exact message", async () => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "crew", "wes-crew"),
    roster(relay, "crew", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters.some((filter) => filter.search !== undefined))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const open = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="wes-cr"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={open}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    const request = wire.next();
    expect(request.filters).toEqual([
      {
        kinds: [40002, 40008, 9], // The real reader canonicalizes set order.
        search: "wes-cr",
        search_mode: "prefix",
        limit: 20,
      },
    ]);
    await act(async () =>
      request.fail(new ReadError("unavailable", "Relay read timed out")),
    );
    expect(
      screen.getByText(/Message search couldn’t finish: Relay read timed out/),
    ).toBeVisible();
    expect(screen.getByRole("option", { name: /wes-crew/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry messages" }));
    expect(screen.queryByText(/Message search couldn’t finish/)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    const hit = message(viewer, "crew", "wes-crew exact message", 1700000001);
    await act(async () => wire.next().respond([hit]));
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    // Typed text selects the first result; the late message sits below it.
    expect(
      screen.getByRole("option", { name: /^wes-crew(?! exact)/ }),
    ).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(
      screen.getByRole("option", { name: /wes-crew exact message/ }),
    ).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(open).toHaveBeenCalledExactlyOnceWith("crew", hit.id);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("scopes conversation search at the relay and discards out-of-scope hits", async () => {
  vi.useFakeTimers();
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
    metadata(relay, "other", "other"),
    roster(relay, "other", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters.some((filter) => filter.search !== undefined))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const changeScope = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="scope"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        scopedChannelId="crew"
        onScopeChange={changeScope}
        openConversation={() => {}}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(180));
    const request = wire.next();
    expect(request.filters).toEqual([
      {
        kinds: [40002, 40008, 9],
        search: "scope",
        search_mode: "prefix",
        limit: 20,
        "#h": ["crew"],
      },
    ]);
    await act(async () =>
      request.respond([
        message(viewer, "crew", "scope match", 1700000001),
        message(viewer, "other", "scope elsewhere", 1700000002),
      ]),
    );
    expect(screen.getByRole("option", { name: /scope match/ })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /scope elsewhere/ }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /Remove .* search scope/ }),
    );
    expect(changeScope).toHaveBeenCalledExactlyOnceWith();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["metadata", "denial"])(
  "does not resurrect displayed public hits after %s loss and regrant",
  async (loss) => {
    vi.useFakeTimers();
    const relay = keypair(),
      viewer = keypair();
    const hit = message(viewer, "open", "crew public result", 1700000000);
    let live: LiveCallbacks | undefined;
    const metadata = (privateChannel: boolean, created_at: number) =>
      signed(relay, {
        kind: 39000,
        created_at,
        content: "",
        tags: [
          ["d", "open"],
          ["name", "Public"],
          [privateChannel ? "private" : "public"],
        ],
      });
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      async query(filters) {
        return filters.some((filter) => filter.search)
          ? [hit]
          : filters.some((filter) => filter.kinds?.includes(39000))
            ? [metadata(false, 1700000000)]
            : [];
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    try {
      render(
        <SearchResults
          session={owner.session}
          query="crew"
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openConversation={() => {}}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(180);
      });
      expect(
        screen.getByRole("option", { name: /crew public result/ }),
      ).toBeVisible();
      const before = owner.session.channels.list();
      act(() => {
        if (loss === "denial")
          live?.denied("open", "restricted: not a channel member");
        else live?.receive([metadata(true, 1700000001)]);
        const denied = owner.session.channels.list();
        expect(denied).not.toBe(before);
        expect(denied.channels).toBe(before.channels);
        live?.receive([metadata(false, 1700000002)]);
      });
      expect(
        screen.queryByRole("option", { name: /crew public result/ }),
      ).toBeNull();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("does not reveal a revoked public hit queued before React commits its result", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const hit = message(viewer, "open", "crew queued result", 1700000000);
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live: LiveCallbacks | undefined;
  const publicEvent = (created_at: number) =>
    signed(relay, {
      kind: 39000,
      created_at,
      content: "",
      tags: [["d", "open"], ["public"]],
    });
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters.some((filter) => filter.search))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        filters.some((filter) => filter.kinds?.includes(39000))
          ? [publicEvent(1700000000)]
          : [],
      );
    },
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    await act(async () => {
      wire.next().respond([hit]);
      // Drain the finite reader and palette's promise callback, without a React commit.
      await vi.advanceTimersByTimeAsync(0);
      live?.denied("open", "restricted: not a channel member");
      live?.receive([publicEvent(1700000001)]);
    });
    expect(
      screen.queryByRole("option", { name: /crew queued result/ }),
    ).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["", "Crew"])(
  "explains cold conversation loading without redundant banners (query=%s)",
  async (query) => {
    const relay = keypair();
    const viewer = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const discovery = [
      metadata(relay, "crew", "Crew"),
      roster(relay, "crew", [viewer.pubkey]),
    ];
    const owner = createRelaySession({
      ...wire.transport,
      query(filters, signal) {
        return filters.some((filter) => filter.kinds?.includes(39002))
          ? wire.transport.query(filters, signal)
          : Promise.resolve(discovery);
      },
    });
    try {
      render(
        <SearchResults
          session={owner.session}
          query={query}
          onQueryChange={() => {}}
          input={createRef()}
          pages={[
            {
              key: "settings",
              label: "Settings",
              icon: ChatCircleIcon,
              run() {},
            },
          ]}
          openConversation={() => {}}
        />,
      );
      const pending = wire.next();
      expect(owner.session.channels.list().status).toBe("loading");
      expect(screen.getByRole("option", { name: /Settings/ })).toBeVisible();
      if (query) {
        expect(screen.getByText("Loading joined conversations…")).toBeVisible();
        expect(screen.queryByText("Loading recent conversations…")).toBeNull();
      } else {
        expect(screen.getByText("Loading recent conversations…")).toBeVisible();
        expect(screen.queryByText("Loading joined conversations…")).toBeNull();
      }
      await act(async () => pending.respond(discovery));
      expect(await screen.findByRole("option", { name: /Crew/ })).toBeVisible();
      expect(screen.queryByText("Loading joined conversations…")).toBeNull();
      expect(screen.getByRole("option", { name: /Settings/ })).toBeVisible();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("does not announce conversation enrichment over retained search choices", () => {
  const owner = createRelaySession(null);
  const session = {
    ...owner.session,
    channels: {
      ...owner.session.channels,
      list: () => list,
      ensureList() {},
    },
  };
  const list = {
    status: "loading" as const,
    channels: [{ id: "crew", name: "Crew", channelType: "stream" as const }],
  };
  try {
    render(
      <SearchResults
        session={session}
        query="Crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(screen.getByRole("option", { name: /Crew/ })).toBeVisible();
    expect(screen.queryByText("Loading joined conversations…")).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("finds joined archived channels by name without putting them in Recent activity", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    signed(relay, {
      kind: 39000,
      created_at: 1700000000,
      content: "",
      tags: [
        ["d", "archive"],
        ["t", "stream"],
        ["name", "Past project"],
        ["archived", "true"],
      ],
    }),
    roster(relay, "archive", [viewer.pubkey]),
    metadata(relay, "active", "Current project"),
    roster(relay, "active", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      return discovery.filter((event) =>
        filters.some((filter) => filter.kinds?.includes(event.kind)),
      );
    },
  });
  const open = vi.fn();
  const props = {
    session: owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openConversation: open,
  };
  try {
    const mounted = render(<SearchResults {...props} query="" />);
    await screen.findByRole("option", { name: /Current project/ });
    expect(screen.queryByRole("option", { name: /Past project/ })).toBeNull();
    mounted.rerender(<SearchResults {...props} query="Past" />);
    fireEvent.click(
      await screen.findByRole("option", {
        name: /Past project/,
      }),
    );
    expect(screen.getByText("Archived channel")).toBeTruthy();
    expect(open).toHaveBeenCalledExactlyOnceWith("archive");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([
  { channelType: "stream", readOnly: true },
  { channelType: "session" },
  { channelType: "dm" },
] as const)(
  "does not surface archived nonmember or non-channel destinations: %j",
  (state) => {
    const owner = createRelaySession(null);
    const snapshot = {
      status: "ready" as const,
      channels: [
        {
          id: "excluded",
          name: "Past project",
          archived: true as const,
          ...state,
        },
      ],
    };
    const session = {
      ...owner.session,
      channels: {
        ...owner.session.channels,
        list: () => snapshot,
        ensureList() {},
      },
    };
    try {
      render(
        <SearchResults
          session={session}
          query="Past"
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openConversation={() => {}}
        />,
      );
      expect(screen.queryByRole("option", { name: /Past project/ })).toBeNull();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("finds active public channels the viewer has not joined without adding them to the joined list", async () => {
  const relay = keypair();
  const viewer = keypair();
  const other = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const open = [
    ["public", ""],
    ["t", "stream"],
  ];
  const discovery = [
    metadata(relay, "joined", "crew-chat", 1700000000, open),
    roster(relay, "joined", [viewer.pubkey]),
    metadata(relay, "lobby", "crew-lobby", 1700000000, open),
    roster(relay, "lobby", [other.pubkey]),
    metadata(relay, "secret", "crew-secret", 1700000000, [
      ["private", ""],
      ["t", "stream"],
    ]),
    metadata(relay, "old", "crew-old", 1700000000, [
      ...open,
      ["archived", "true"],
    ]),
    metadata(relay, "dm", "crew-dm", 1700000000, [
      ["public", ""],
      ["hidden", ""],
      ["t", "dm"],
    ]),
    // Only relay-signed metadata is channel authority.
    metadata(other, "forged", "crew-forged", 1700000000, open),
  ];
  const reads: unknown[] = [];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      reads.push(filters);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={openConversation}
      />,
    );
    const lobby = await screen.findByRole("option", { name: /crew-lobby/ });
    expect(lobby).toHaveTextContent("Public channel · not joined");
    const group = within(screen.getByRole("group", { name: "Channels" }));
    expect(
      group.getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
      expect.stringContaining("crew-chat"),
      expect.stringContaining("crew-lobby"),
    ]);
    for (const hidden of ["crew-secret", "crew-old", "crew-dm", "crew-forged"])
      expect(
        screen.queryByRole("option", { name: new RegExp(hidden) }),
      ).toBeNull();
    // The match resolved through exact signed metadata and the viewer roster.
    expect(reads).toContainEqual([
      expect.objectContaining({ kinds: [39000], "#d": ["lobby"] }),
      expect.objectContaining({
        kinds: [39002],
        "#d": ["lobby"],
        "#p": [viewer.pubkey],
      }),
    ]);
    expect(owner.session.channels.get?.("lobby")).toMatchObject({
      readOnly: true,
      name: "crew-lobby",
    });
    expect(
      owner.session.channels.list().channels.map((channel) => channel.id),
    ).toEqual(["joined"]);
    fireEvent.click(lobby);
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("lobby");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("returns keyboard focus to search when channel lookup retries, through repeated failure and recovery", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const relay = keypair();
  const viewer = keypair();
  const other = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const open = [
    ["public", ""],
    ["t", "stream"],
  ];
  const discovery = [
    metadata(relay, "joined", "other-chat", 1700000000, open),
    roster(relay, "joined", [viewer.pubkey]),
    metadata(relay, "lobby", "crew-lobby", 1700000000, open),
    roster(relay, "lobby", [other.pubkey]),
  ];
  let failures = 2;
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      // Only the public-channel page read fails; exact lookups still succeed.
      if (
        failures > 0 &&
        filters.some(
          (filter) => filter.kinds?.includes(39000) && !filter["#d"],
        ) &&
        !filters.some((filter) => filter.kinds?.includes(39002))
      ) {
        failures--;
        return Promise.reject(new Error("Relay read timed out"));
      }
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={openConversation}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const retry = await screen.findByRole("button", {
        name: "Retry channels",
      });
      retry.focus();
      fireEvent.click(retry);
      expect(
        screen.queryByRole("button", { name: "Retry channels" }),
      ).toBeNull();
      expect(input).toHaveFocus();
    }
    const lobby = await screen.findByRole("option", { name: /crew-lobby/ });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(lobby).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("lobby");
  } finally {
    cleanup();
    owner.dispose();
  }
});

function usageSession(
  names: readonly string[],
  publicNames: readonly string[] = [],
) {
  const relay = keypair();
  const viewer = keypair();
  const other = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const open = [
    ["public", ""],
    ["t", "stream"],
  ];
  const discovery = [
    ...names.flatMap((name, index) => [
      metadata(relay, name, name, 1700000000 + index),
      roster(relay, name, [viewer.pubkey]),
    ]),
    ...publicNames.flatMap((name) => [
      metadata(relay, name, name, 1700000000, open),
      roster(relay, name, [other.pubkey]),
    ]),
  ];
  return createRelaySession({
    ...wire.transport,
    query(filters) {
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
}

const usage = `wss://relay.example:${"a".repeat(64)}`;
const optionNames = (group: string) =>
  within(screen.getByRole("group", { name: group }))
    .getAllByRole("option")
    .map((option) => option.textContent?.split(/Conversation|Public/)[0]);

it("puts the earlier choice for typed text first, unless another name is exact", async () => {
  localStorage.clear();
  recordChoice(usage, "wo", "channel:team-work");
  const owner = usageSession(["work", "team-work", "workshop"]);
  const open = vi.fn();
  const props = {
    session: owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLElement>(),
    pages: [],
    openConversation: open,
    usageScope: usage,
  };
  try {
    const { rerender } = render(<SearchResults {...props} query="wor" />);
    await waitFor(() =>
      expect(optionNames("Channels")).toEqual([
        "team-work",
        "work",
        "workshop",
      ]),
    );
    const combobox = screen.getByRole("combobox", { name: "Search Buzz" });
    fireEvent.keyDown(combobox, { key: "Enter" });
    expect(open).toHaveBeenLastCalledWith("team-work");
    // Typing a channel's whole name opens that channel.
    rerender(<SearchResults {...props} query="work" />);
    expect(optionNames("Channels")).toEqual(["work", "team-work", "workshop"]);
    fireEvent.keyDown(combobox, { key: "Enter" });
    expect(open).toHaveBeenLastCalledWith("work");
    // Each choice is remembered for the text that led to it.
    const remembered = readSearchUsage(usage);
    const all = new Set(["channel:work", "channel:team-work"]);
    expect(remembered.pick("work", all)).toBe("channel:work");
    expect(remembered.pick("wor", all)).toBe("channel:team-work");
  } finally {
    cleanup();
    owner.dispose();
    localStorage.clear();
  }
});

it("lets frequent visits lift a match past a slightly better one, not a much better one", async () => {
  localStorage.clear();
  for (let visit = 0; visit < 20; visit++) {
    recordVisit(usage, "channel:the-lar");
    recordVisit(usage, "channel:xlarx");
  }
  const owner = usageSession(["xlarx", "the-lar", "lar-crew"]);
  try {
    render(
      <SearchResults
        session={owner.session}
        query="lar"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
        usageScope={usage}
      />,
    );
    // Word start beats prefix with usage; a busy substring match does not.
    await waitFor(() =>
      expect(optionNames("Channels")).toEqual(["the-lar", "lar-crew", "xlarx"]),
    );
  } finally {
    cleanup();
    owner.dispose();
    localStorage.clear();
  }
});

it("keeps the remembered choice selected when a better match arrives late", async () => {
  localStorage.clear();
  recordChoice(usage, "wor", "Workflows");
  const owner = usageSession([], ["wor"]);
  const workflows = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="wor"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[
          {
            key: "Workflows",
            label: "Workflows",
            icon: ChatCircleIcon,
            run: workflows,
          },
        ]}
        openConversation={() => {}}
        usageScope={usage}
      />,
    );
    const page = screen.getByRole("option", { name: "Workflows" });
    expect(page).toHaveAttribute("aria-selected", "true");
    // The relay's exact public match leads its group above Pages, later.
    await screen.findByRole("option", { name: /^wor/ });
    expect(
      screen
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-label"))
        .slice(0, 2),
    ).toEqual(["Channels", "Pages"]);
    expect(page).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    expect(workflows).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    owner.dispose();
    localStorage.clear();
  }
});
