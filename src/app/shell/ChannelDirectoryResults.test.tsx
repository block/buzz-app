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
import { ChannelLifecycleUnconfirmed } from "../../features/relay/channel-lifecycle";
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
    /** Stands in for the relay's answer to a Join. */
    join?: (channelId: string) => Promise<void>;
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
  const joins: string[] = [];
  const join = options.join;
  const connection = {
    status: "ready",
    session: join
      ? {
          ...owner.session,
          channelLifecycle: {
            ...owner.session.channelLifecycle,
            available: true,
            run: (action: string, channelId: string) => {
              joins.push(`${action}:${channelId}`);
              return join(channelId);
            },
          },
        }
      : owner.session,
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
    joins,
    directoryReads: () => directoryReads,
    countReads: () => countReads,
    recover: () => {
      failing = false;
    },
    /** The relay adds the viewer to `channelId`, live, as a Join does. */
    admit(channelId: string) {
      live?.state({ status: "connected", routes: [] });
      live?.receive([
        roster(relay, channelId, [other.pubkey, viewer.pubkey], 1700000200),
      ]);
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
const browse = async () => {
  act(() => {
    window.dispatchEvent(new Event("buzz:browse-channels"));
  });
  return screen.findByRole("dialog", { name: "Browse channels" });
};
const field = () => screen.getByRole("combobox", { name: "Search channels" });
/** Each row as it is announced: its name, then what it says beneath. */
const rows = () =>
  Array.from(
    screen
      .getByRole("grid", { name: "Channels" })
      .querySelectorAll('[role="row"]'),
    (row) => row.getAttribute("aria-label"),
  );
const offered = [
  expect.stringContaining("buzz-community"),
  expect.stringContaining("design-crit"),
  expect.stringContaining("release-notes"),
];

it("Browse channels lists the open channels to join A–Z, and nothing else of search", async () => {
  const t = connected();
  try {
    t.render();
    const dialog = await browse();
    await waitFor(() => expect(rows()).toEqual(offered));
    expect(field()).toHaveFocus();
    expect(field()).toHaveAttribute("placeholder", "Search channels");
    expect(
      screen.getByRole("rowgroup", { name: "Channels you can join" }),
    ).toBeVisible();
    // One plain list: no rail of result groups and no preview beside it.
    expect(within(dialog).queryByRole("navigation")).toBeNull();
    expect(within(dialog).queryByRole("complementary")).toBeNull();
    // Member counts fill in after the rows, in one read for the rows shown.
    await waitFor(() =>
      expect(rows()).toEqual([
        "buzz-community — 2 members · Questions and tips",
        "design-crit — 1 member",
        "release-notes — 1 member",
      ]),
    );
    expect(t.countReads()).toBe(1);
    // Joined (guests included), archived and private channels aren't
    // offered to join.
    for (const hidden of [
      /^design$/,
      /design-guests/,
      /design-private/,
      /old-news/,
      /secret-plans/,
    ])
      expect(screen.queryByRole("row", { name: hidden })).toBeNull();
    // The first row is ready for Enter, which opens its preview.
    expect(screen.getAllByRole("row")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );
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

it("marks joined matches and says when nothing matches", async () => {
  const t = connected();
  try {
    t.render();
    await browse();
    await userEvent.type(field(), "design");
    await waitFor(() =>
      expect(rows()).toEqual([
        "design — Joined · 1 member",
        // Guests are members, open or private, so they're marked Joined.
        "design-guests — Joined · 1 member",
        "design-private — Joined · 1 member",
        "design-crit — 1 member",
      ]),
    );
    await userEvent.clear(field());
    await userEvent.type(field(), "zzz");
    expect(await screen.findByText("No matching channels.")).toBeVisible();
    expect(
      screen.getByText("Private channels show up once someone invites you."),
    ).toBeVisible();
  } finally {
    await t.dispose();
  }
});

it("leaves search as it was: ⌘K after browsing opens all of search, fresh", async () => {
  const t = connected();
  try {
    t.render();
    await browse();
    await userEvent.type(field(), "design");
    await waitFor(() => expect(rows()).toHaveLength(4));
    await userEvent.click(screen.getByRole("row", { name: /^design-crit/ }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Browse channels" }),
      ).toBeNull(),
    );
    await openSearch();
    expect(screen.getByRole("combobox", { name: "Search Buzz" })).toHaveValue(
      "",
    );
    // And browsing again starts from the whole list, not the last text.
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Search Buzz" })).toBeNull(),
    );
    await browse();
    expect(field()).toHaveValue("");
    await waitFor(() => expect(rows()).toEqual(offered));
  } finally {
    await t.dispose();
  }
});
it("shows a failed directory read with a retry", async () => {
  const t = connected({ fail: true });
  try {
    t.render();
    await browse();
    expect(
      await screen.findByText("Couldn’t load channels.", undefined, {
        timeout: 5000,
      }),
    ).toBeVisible();
    t.recover();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry channels" }),
    );
    await waitFor(() =>
      expect(rows()).toContainEqual(expect.stringContaining("buzz-community")),
    );
    expect(screen.queryByText("Couldn’t load channels.")).toBeNull();
  } finally {
    await t.dispose();
  }
});

it("draws the first rows of a long list and more as its end nears, counting them all", async () => {
  const observed = new Set<Element>();
  let report: IntersectionObserverCallback = () => {};
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        report = callback;
      }
      observe(row: Element) {
        observed.add(row);
      }
      unobserve(row: Element) {
        observed.delete(row);
      }
      disconnect() {
        observed.clear();
      }
    },
  );
  const t = connected({ newer: 150 });
  try {
    t.render();
    await browse();
    await waitFor(() => expect(rows()).toHaveLength(100));
    const options = screen.getAllByRole("row");
    // Assistive technology hears the whole list's size, once it settles.
    expect(
      await screen.findByText("153 channels you can join", undefined, {
        timeout: 2000,
      }),
    ).toBeInTheDocument();
    // A row well above the end coming into view draws nothing more.
    const near = (index: number) =>
      options[index]?.closest("[data-search-key]") ?? undefined;
    const show = (row: Element | undefined) =>
      act(() =>
        report(
          [{ target: row, isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        ),
      );
    show(near(10));
    expect(rows()).toHaveLength(100);
    // Nearing the last drawn rows draws the rest.
    show(near(90));
    await waitFor(() => expect(rows()).toHaveLength(153));
    // Every drawn row is watched once, the old ones still included.
    expect(observed.size).toBe(153);
  } finally {
    await t.dispose();
  }
});

it("reads the directory again when access changes while Browse channels shows it", async () => {
  const t = connected();
  try {
    t.render();
    await browse();
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
it("shows the directory's first page while the rest loads", async () => {
  let release = () => {};
  const later = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Pages of 10: the 10 newest fill the first, and the rest are one more.
  const t = connected({ newer: 10, later, page: 10 });
  try {
    t.render();
    await browse();
    // The newest page arrives first and shows while the older page is held.
    await waitFor(() => expect(rows()).toHaveLength(10));
    expect(rows()[0]).toContain("team-000");
    expect(screen.getByText("Loading more channels…")).toBeVisible();
    expect(rows()).not.toContainEqual(
      expect.stringContaining("buzz-community"),
    );
    release();
    await waitFor(() =>
      expect(screen.queryByText("Loading more channels…")).toBeNull(),
    );
    // The older page joins below them rather than reshuffling the rows
    // already shown, A–Z among itself.
    expect(rows()).toHaveLength(13);
    expect(rows()[0]).toContain("team-000");
    expect(rows().slice(10)).toEqual([
      expect.stringContaining("buzz-community"),
      expect.stringContaining("design-crit"),
      expect.stringContaining("release-notes"),
    ]);
    // Opened again on the finished read, the whole list is A–Z.
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Browse channels" }),
      ).toBeNull(),
    );
    await browse();
    await waitFor(() => expect(rows()[0]).toContain("buzz-community"));
  } finally {
    release();
    await t.dispose();
  }
});

it("reads the directory again when access changes while its pages load", async () => {
  let release = () => {};
  const later = new Promise<void>((resolve) => {
    release = resolve;
  });
  const t = connected({ newer: 10, later, page: 10 });
  try {
    t.render();
    await browse();
    await waitFor(() => expect(rows()).toHaveLength(10));
    const reads = t.directoryReads();
    // The held page's read is now stale; a fresh read replaces it, unasked.
    t.revoke("guest-private");
    await waitFor(() => expect(t.directoryReads()).toBeGreaterThan(reads));
    release();
    await waitFor(() =>
      expect(screen.queryByText("Loading more channels…")).toBeNull(),
    );
    expect(rows()).toHaveLength(13);
    expect(screen.queryByText("Couldn’t load channels.")).toBeNull();
  } finally {
    release();
    await t.dispose();
  }
});

it("puts joined matches first among equal matches after later pages land", async () => {
  let release = () => {};
  const later = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The 4 newest fill the first page; design-crit lands on a later one while
  // Browse channels shows, and joined channels never land at all.
  const t = connected({ newer: 4, prefix: "design-new", page: 4, later });
  try {
    t.render();
    await browse();
    await waitFor(() => expect(rows()).toHaveLength(4));
    release();
    await waitFor(() =>
      expect(screen.queryByText("Loading more channels…")).toBeNull(),
    );
    await userEvent.type(field(), "design-");
    await waitFor(() =>
      expect(rows().map((row) => row?.split(" — ")[0])).toEqual([
        "design-guests",
        "design-private",
        "design-new-000",
        "design-new-001",
        "design-new-002",
        "design-new-003",
        "design-crit",
      ]),
    );
  } finally {
    release();
    await t.dispose();
  }
});

it("joins from the list: the row keeps its place and says Joined", async () => {
  let land = () => {};
  const t = connected({
    join: () =>
      new Promise<void>((resolve) => {
        land = resolve;
      }),
  });
  try {
    t.render();
    await browse();
    await waitFor(() => expect(rows()).toEqual(offered));
    // Joined channels offer no Join.
    expect(screen.queryByRole("button", { name: /^Join design$/ })).toBeNull();
    const button = screen.getByRole("button", { name: "Join design-crit" });
    await userEvent.click(button);
    expect(t.joins).toEqual(["join:design-crit"]);
    // Choosing Join doesn't also open the channel.
    expect(t.navigate).not.toHaveBeenCalled();
    expect(button).toHaveAttribute("aria-busy", "true");
    // A second click while it runs starts nothing more.
    await userEvent.click(button);
    expect(t.joins).toHaveLength(1);
    // Membership lands as the Join settles: the row stays, not hidden as
    // already joined.
    act(() => {
      t.admit("design-crit");
      land();
    });
    await waitFor(() =>
      expect(rows()).toEqual([
        expect.stringContaining("buzz-community"),
        "design-crit — Joined · 1 member",
        expect.stringContaining("release-notes"),
      ]),
    );
    expect(
      screen.queryByRole("button", { name: "Join design-crit" }),
    ).toBeNull();
    // Focus left with the Join it was on, back to the field.
    expect(field()).toHaveFocus();
    // The list stays open for the next one.
    expect(
      screen.getByRole("button", { name: "Join release-notes" }),
    ).toBeVisible();
  } finally {
    await t.dispose();
  }
});

it("says on its row why a Join failed, and Join tries again", async () => {
  let fail = true;
  const t = connected({
    join: () =>
      fail
        ? Promise.reject(new ChannelLifecycleUnconfirmed(new Error("timeout")))
        : Promise.resolve(),
  });
  try {
    t.render();
    await browse();
    await waitFor(() => expect(rows()).toEqual(offered));
    await userEvent.click(
      screen.getByRole("button", { name: "Join release-notes" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Join may have taken effect, but it is not confirmed yet. Try again to check.",
    );
    fail = false;
    await userEvent.click(
      screen.getByRole("button", { name: "Join release-notes" }),
    );
    await waitFor(() =>
      expect(rows()).toContain("release-notes — Joined · 1 member"),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(t.joins).toEqual(["join:release", "join:release"]);
  } finally {
    await t.dispose();
  }
});

it("says Joined once membership shows, though the Join wasn't confirmed", async () => {
  const t = connected({
    join: () =>
      Promise.reject(new ChannelLifecycleUnconfirmed(new Error("timeout"))),
  });
  try {
    t.render();
    await browse();
    await waitFor(() => expect(rows()).toEqual(offered));
    await userEvent.click(
      screen.getByRole("button", { name: "Join release-notes" }),
    );
    expect(await screen.findByRole("alert")).toBeVisible();
    act(() => t.admit("release"));
    await waitFor(() =>
      expect(rows()).toContain("release-notes — Joined · 1 member"),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Join release-notes" }),
    ).toBeNull();
  } finally {
    await t.dispose();
  }
});
