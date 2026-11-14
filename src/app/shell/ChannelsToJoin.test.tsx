// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Filter, matchFilter } from "nostr-tools";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RegisteredPage } from "../../features/pages/service";
import type { LiveCallbacks } from "../../features/relay/live";
import { createRelaySession } from "../../features/relay/session";
import {
  keypair,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "../../features/relay/testing";
import { createShortcutBindings } from "../../features/shortcuts/preferences";
import { ShortcutsService } from "../../features/shortcuts/service";
import { PageSearch, type SearchServices } from "./PageSearch";

// jsdom lacks scrollIntoView; the palette reveals its typed-text selection.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

const pages: RegisteredPage[] = [
  {
    key: "buzz.channels/channels",
    pluginId: "buzz.channels",
    id: "channels",
    title: "Channels",
    revision: "bundled",
    component: () => null,
  },
];
const open = [
  ["public", ""],
  ["t", "stream"],
];

/** A connected search over a scripted relay: the viewer is in `design`, and
 * `buzz-community` and `release-notes` are open to join. */
function connected(
  options: {
    fail?: boolean;
    /** Newer open channels, which fill the directory's first page. */
    newer?: number;
    /** The newer channels' name prefix. */
    prefix?: string;
    /** Holds the directory's later pages until it settles. */
    later?: Promise<void>;
    /** The directory's page size. */
    page?: number;
  } = {},
) {
  const relay = keypair();
  const viewer = keypair();
  const other = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "design", "design", 1700000000, open),
    roster(relay, "design", [viewer.pubkey]),
    metadata(relay, "release", "release-notes", 1700000000, open),
    roster(relay, "release", [other.pubkey]),
    metadata(relay, "community", "buzz-community", 1700000000, [
      ...open,
      ["about", "Questions and tips"],
    ]),
    roster(relay, "community", [other.pubkey, relay.pubkey]),
    metadata(relay, "design-crit", "design-crit", 1700000000, open),
    roster(relay, "design-crit", [other.pubkey]),
    // The viewer is a read-only guest in both of these: still a member.
    metadata(relay, "guest-open", "design-guests", 1700000000, open),
    signed(relay, {
      kind: 39002,
      content: "",
      tags: [
        ["d", "guest-open"],
        ["p", viewer.pubkey, "", "guest"],
      ],
    }),
    metadata(relay, "guest-private", "design-private", 1700000000, [
      ["private", ""],
      ["t", "stream"],
    ]),
    signed(relay, {
      kind: 39002,
      content: "",
      tags: [
        ["d", "guest-private"],
        ["p", viewer.pubkey, "", "guest"],
      ],
    }),
    metadata(relay, "old", "old-news", 1700000000, [
      ...open,
      ["archived", "true"],
    ]),
    metadata(relay, "secret", "secret-plans", 1700000000, [
      ["private", ""],
      ["t", "stream"],
    ]),
    ...Array.from({ length: options.newer ?? 0 }, (_, index) =>
      metadata(
        relay,
        `bulk-${index}`,
        `${options.prefix ?? "team"}-${String(index).padStart(3, "0")}`,
        1700000100 + index,
        open,
      ),
    ),
  ];
  let failing = options.fail ?? false;
  /** Exact reads of open channels' rosters, for their member counts. */
  let countReads = 0;
  /** Paged reads of the whole open directory, as opposed to exact lookups. */
  let directoryReads = 0;
  let live: LiveCallbacks | undefined;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
      query(filters) {
        const directory = filters.some(
          (filter) =>
            filter.kinds?.includes(39000) && !filter["#p"] && !filter["#d"],
        );
        if (directory) directoryReads += 1;
        if (
          filters.some(
            (filter) => filter.kinds?.includes(39002) && !filter["#p"],
          )
        )
          countReads += 1;
        // Only the directory's paged read fails, not the joined list.
        if (failing && directory) return Promise.reject(new Error("offline"));
        const [filter] = filters;
        if (directory && filter) {
          // The relay's pages: newest first, then by id, after the cursor.
          const { limit, until, before_id, ...match } = filter as Filter & {
            before_id?: string;
          };
          const page = discovery
            .filter((event) => matchFilter(match as Filter, event))
            .sort(
              (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
            )
            .filter(
              (event) =>
                until === undefined ||
                event.created_at < until ||
                (event.created_at === until && event.id > (before_id ?? "")),
            )
            .slice(0, limit);
          return until === undefined || !options.later
            ? Promise.resolve(page)
            : options.later.then(() => page);
        }
        return Promise.resolve(
          discovery.filter((event) =>
            filters.some((filter) => matchFilter(filter as Filter, event)),
          ),
        );
      },
    },
    options.page ? { publicDirectoryPage: options.page } : {},
  );
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(root, window, bindings);
  const navigate = vi.fn(async () => {});
  const connection = {
    status: "ready",
    session: owner.session,
    scope: "scope",
    generation: 0,
  };
  const community = {
    selected: "wss://relay.example",
    viewer: viewer.pubkey,
  };
  const services = {
    shortcuts,
    shortcutBindings: bindings,
    navigation: {
      subscribe: () => () => {},
      snapshot: () => ({ entry: { target: null } }),
      open: navigate,
    },
    communities: {
      subscribe: () => () => {},
      snapshot: () => community,
      relay: { subscribe: () => () => {}, snapshot: () => connection },
    },
  } as unknown as SearchServices;
  return {
    navigate,
    directoryReads: () => directoryReads,
    countReads: () => countReads,
    recover: () => {
      failing = false;
    },
    /** The relay drops the viewer from `channelId`, live, in this session. */
    revoke(channelId: string) {
      live?.state({ status: "connected", routes: [] });
      live?.receive([roster(relay, channelId, [], 1700000200)]);
    },
    render: () =>
      render(
        <PageSearch pages={pages} onSelect={vi.fn()} services={services} />,
      ),
    async dispose() {
      cleanup();
      bindings.dispose();
      await root.fiber.dispose();
      owner.dispose?.();
    },
  };
}

const openSearch = async () => {
  await userEvent.click(screen.getByRole("button", { name: "Search Buzz" }));
  return screen.findByRole("dialog", { name: "Search Buzz" });
};
/** What the sidebar's Browse channels asks for. */
const browseChannels = async () => {
  act(() => {
    window.dispatchEvent(new Event("buzz:browse-channels"));
  });
  return screen.findByRole("dialog", { name: "Search Buzz" });
};
const toJoin = () => screen.queryByRole("group", { name: "Channels to join" });
const rows = () =>
  Array.from(
    toJoin()?.querySelectorAll('[role="option"]') ?? [],
    (row) => row.textContent,
  );
const offered = [
  expect.stringContaining("buzz-community"),
  expect.stringContaining("design-crit"),
  expect.stringContaining("release-notes"),
];

it("Browse channels opens search on the open channels to join, A–Z", async () => {
  const t = connected();
  try {
    t.render();
    await browseChannels();
    await waitFor(() => expect(rows()).toEqual(offered));
    // Its first row is highlighted, ready for Enter.
    expect(
      within(toJoin() as HTMLElement).getAllByRole("option")[0],
    ).toHaveAttribute("aria-selected", "true");
    // The rail says which group is shown.
    expect(
      screen.getByRole("button", { name: /Channels to join/, pressed: true }),
    ).toBeVisible();
    // Member counts fill in after the rows, in one read for the rows shown.
    await waitFor(() =>
      expect(rows()).toEqual([
        expect.stringContaining("2 members · Questions and tips"),
        expect.stringContaining("1 member"),
        expect.stringContaining("1 member"),
      ]),
    );
    expect(t.countReads()).toBe(1);
    // Joined (guests included), archived and private channels aren't offered.
    for (const hidden of [
      /^design( —|$)/,
      /design-guests/,
      /design-private/,
      /old-news/,
      /secret-plans/,
    ])
      expect(
        within(toJoin() as HTMLElement).queryByRole("option", { name: hidden }),
      ).toBeNull();
    // The first row is ready for Enter, which opens its preview.
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(t.navigate).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "conversation",
          channelId: "community",
        }),
      ),
    );
  } finally {
    await t.dispose();
  }
});

it("lists Channels to join in an empty search's rail, and Escape goes back", async () => {
  const t = connected();
  try {
    t.render();
    await openSearch();
    // The overview doesn't list them; the rail does.
    expect(toJoin()).toBeNull();
    await userEvent.click(
      await screen.findByRole("button", { name: /Channels to join/ }),
    );
    await waitFor(() => expect(rows()).toEqual(offered));
    // Typed text searches everything, open channels among Channels.
    await userEvent.type(
      screen.getByRole("combobox", { name: "Search Buzz" }),
      "buzz",
    );
    await waitFor(() => expect(toJoin()).toBeNull());
    await userEvent.clear(
      screen.getByRole("combobox", { name: "Search Buzz" }),
    );
    await waitFor(() => expect(rows()).toEqual(offered));
    // Escape returns to the overview before it closes search.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(toJoin()).toBeNull());
    expect(screen.getByRole("dialog", { name: "Search Buzz" })).toBeVisible();
    // The directory read search started was shared, not repeated.
    expect(t.directoryReads()).toBe(1);
  } finally {
    await t.dispose();
  }
});

it("offers Retry when the directory read fails", async () => {
  const t = connected({ fail: true });
  try {
    t.render();
    await browseChannels();
    const retry = await screen.findByRole(
      "option",
      { name: /Retry loading channels/ },
      { timeout: 5000 },
    );
    expect(retry).toHaveTextContent("Couldn’t load open channels.");
    t.recover();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(rows()).toEqual(offered));
    expect(
      screen.queryByRole("option", { name: /Retry loading channels/ }),
    ).toBeNull();
  } finally {
    await t.dispose();
  }
});

it("keeps rows in place as later pages land, then is A–Z", async () => {
  let release = () => {};
  const later = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Pages of 10: the 10 newest fill the first, and the rest are one more.
  const t = connected({ newer: 10, later, page: 10 });
  try {
    t.render();
    await browseChannels();
    await waitFor(() => expect(rows()).toHaveLength(10));
    expect(rows()[0]).toContain("team-000");
    release();
    // The older page joins below the rows shown, A–Z among itself.
    await waitFor(() => expect(rows()).toHaveLength(13));
    expect(rows()[0]).toContain("team-000");
    expect(rows().slice(10)).toEqual(offered);
    // Opened again on the finished read, the whole list is A–Z.
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await browseChannels();
    await waitFor(() => expect(rows()[0]).toContain("buzz-community"));
  } finally {
    release();
    await t.dispose();
  }
});

it("reads the directory again when access changes while it shows", async () => {
  const t = connected();
  try {
    t.render();
    await browseChannels();
    await waitFor(() => expect(rows()).toEqual(offered));
    const reads = t.directoryReads();
    // Losing another channel drops this session's directory, not the session.
    t.revoke("guest-private");
    await waitFor(() => expect(t.directoryReads()).toBe(reads + 1));
    await waitFor(() => expect(rows()).toEqual(offered));
    expect(screen.queryByText("You’ve joined every open channel.")).toBeNull();
  } finally {
    await t.dispose();
  }
});
