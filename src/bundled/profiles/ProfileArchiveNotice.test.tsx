// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgentSaveState } from "../../features/agents/AgentSaveButton";
import type { Agent, Agents } from "../../features/agents/service";
import { PanelDock } from "../../features/panels/PanelDock";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import { profileTarget } from "../../features/profiles/target";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import type { LiveCallbacks } from "../../features/relay/live";
import type { RelayData } from "../../features/relay/service";
import { createRelaySession } from "../../features/relay/session";
import {
  keypair,
  type Key,
  profile,
  signed,
} from "../../features/relay/testing";
import { ProfilePanel } from "./ProfilePanel";

const relayKey = keypair();
const old = keypair();
const successor = keypair();
const owners: { dispose(): void }[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
});

function snapshot(keys: string[], created_at?: number) {
  return signed(relayKey, {
    kind: 13535,
    content: "",
    tags: [["-"], ...keys.map((key) => ["p", key])],
    ...(created_at && { created_at }),
  });
}
function delta(
  target: string,
  tags: string[][],
  {
    by = relayKey,
    kind = 8002,
    created_at,
    base = [["-"], ["p", target], ["consent", "self", target]],
  }: { by?: Key; kind?: number; created_at?: number; base?: string[][] } = {},
) {
  return signed(by, {
    kind,
    content: "",
    tags: [...base, ["reason", "rotated"], ...tags],
    ...(created_at && { created_at }),
  });
}
/** `extra` events answer every filter of their kind, whatever its authors:
 * a relay that ignores the authors filter. While `failing.deltas` or
 * `failing.snapshots` is set, those reads fail. While `held.snapshots` is
 * set, snapshot reads wait for it. `tabbed` shows the profile as a retained
 * channel tab beside a thread tab, as Channels and Inbox do; `docked` puts
 * those tabs in a collapsible side dock, as Channels does. */
function mount(
  events: RelayEvent[],
  extra: RelayEvent[] = [],
  {
    ownedBy,
    tabbed,
    docked,
  }: {
    ownedBy?: (viewer: string) => Agents;
    tabbed?: boolean;
    docked?: boolean;
  } = {},
) {
  const failing = { deltas: false, snapshots: false };
  const held: { snapshots?: Promise<void> } = {};
  const query = vi.fn(async (filters: readonly ReadFilter[]) => {
    const snapshots = filters.some((filter) => filter.kinds?.includes(13535));
    // A read that starts while failing fails, also after it is held.
    const fails = snapshots && failing.snapshots;
    if (snapshots && held.snapshots) await held.snapshots;
    if (fails) throw new Error("relay unavailable");
    return filters.flatMap((filter) => {
      if (failing.deltas && filter.kinds?.includes(8002))
        throw new Error("relay unavailable");
      const matches = events
        .filter(
          (event) =>
            (!filter.kinds || filter.kinds.includes(event.kind)) &&
            (!filter.authors || filter.authors.includes(event.pubkey)) &&
            (!filter["#p"] ||
              event.tags.some(
                ([name, key]) =>
                  name === "p" && filter["#p"]?.includes(key ?? ""),
              )),
        )
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, filter.limit);
      return matches.concat(
        extra.filter((event) => filter.kinds?.includes(event.kind)),
      );
    });
  });
  const viewer = keypair().pubkey;
  let live: LiveCallbacks | undefined;
  const owner = createRelaySession({
    viewer,
    relayAuthor: relayKey.pubkey,
    archiveAuthority: relayKey.pubkey,
    scope: "wss://relay.example.test",
    query,
    media: () => undefined,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  const ready = {
    status: "ready" as const,
    generation: 1,
    viewer,
    session: owner.session,
  };
  const relay: RelayData = {
    snapshot: () => ready,
    subscribe: () => () => {},
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const open = vi.fn(() => true);
  const push = vi.fn(() => true);
  const panel = (opening: number) => (
    <ProfilePanel
      key={opening}
      relay={relay}
      {...(ownedBy && { agents: ownedBy(viewer) })}
      target={profileTarget(old.pubkey) ?? ""}
      close={() => {}}
      context={{
        channelId: "c",
        canOpen: () => true,
        open,
        ...(ownedBy && { push }),
      }}
    />
  );
  let openings = 0;
  const view = render(
    tabbed || docked ? (
      <Workspace profile={panel(openings)} docked={docked} />
    ) : (
      panel(openings)
    ),
  );
  /** Closes the profile and opens it again in the same session. */
  const reopen = () => view.rerender(panel(++openings));
  /** The live connection drops. */
  const drop = () => act(() => live?.state({ status: "retrying", routes: [] }));
  /** The dropped connection comes back and its subscription establishes. */
  const restore = () =>
    act(() => {
      live?.state({ status: "connected", routes: [] });
      live?.established();
    });
  /** The live connection drops and comes back. */
  const reconnect = () => {
    drop();
    restore();
  };
  return {
    query,
    open,
    push,
    failing,
    held,
    archives: owner.session.archives,
    drop,
    restore,
    reconnect,
    reopen,
  };
}
/** A thread tab and the profile's tab, both retained while the other shows,
 * optionally in a dock that keeps them while collapsed. */
function Workspace({
  profile,
  docked,
}: {
  profile: ReactNode;
  docked?: boolean | undefined;
}) {
  const [value, select] = useState("profile");
  const [open, setOpen] = useState(true);
  const tabs = (
    <PanelWorkspace
      value={value}
      select={select}
      items={[
        { id: "thread", label: "Thread", content: <p>Thread</p> },
        { id: "profile", label: "Profile", content: profile },
      ]}
    />
  );
  if (!docked) return tabs;
  return (
    <>
      <button type="button" onClick={() => setOpen((shown) => !shown)}>
        {open ? "Collapse" : "Expand"}
      </button>
      <PanelDock open={open} className={undefined} keepMounted>
        {tabs}
      </PanelDock>
    </>
  );
}
const people = [
  profile(old, { name: "Old Key" }),
  profile(successor, { name: "New Key" }),
];

it("links an archived key's replacement from the relay's archive delta", async () => {
  const { open } = mount([
    ...people,
    snapshot([old.pubkey]),
    delta(old.pubkey, [["replaced-by", successor.pubkey]]),
  ]);
  const link = await screen.findByRole("button", {
    name: "Open new key profile: New Key",
  });
  expect(screen.getByTestId("profile-archived")).toHaveTextContent(
    "This key was replaced by New Key.",
  );
  await userEvent.setup().click(link);
  expect(open).toHaveBeenCalledWith(profileTarget(successor.pubkey));
});

it("says archived without a link when no trusted delta names a replacement", async () => {
  // Only the relay identity's deltas count, even if the relay returns others.
  mount(
    [...people, snapshot([old.pubkey])],
    [
      delta(old.pubkey, [["replaced-by", successor.pubkey]], {
        by: keypair(),
      }),
    ],
  );
  await waitFor(() =>
    expect(screen.getByTestId("profile-archived")).toHaveTextContent(
      "This key is archived in this community.",
    ),
  );
  expect(screen.queryByRole("button", { name: /new key profile/ })).toBeNull();
});

it("shows nothing for a key that is not archived, even with an old delta", async () => {
  const { query } = mount([
    ...people,
    snapshot([]),
    delta(old.pubkey, [["replaced-by", successor.pubkey]]),
  ]);
  await screen.findByRole("heading", { name: "Old Key" });
  await waitFor(() =>
    expect(query.mock.calls.flatMap(([filters]) => filters)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kinds: [13535] })]),
    ),
  );
  expect(screen.queryByTestId("profile-archived")).toBeNull();
  expect(query.mock.calls.flatMap(([filters]) => filters)).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ kinds: [8002] })]),
  );
});

describe("ignores a relay delta NIP-IA says to ignore", () => {
  const replaced = [["replaced-by", successor.pubkey]];
  it.each([
    [
      "no protected marker",
      {
        base: [
          ["p", old.pubkey],
          ["consent", "self", old.pubkey],
        ],
      },
    ],
    ["no consent", { base: [["-"], ["p", old.pubkey]] }],
    [
      "an unknown consent path",
      { base: [["-"], ["p", old.pubkey], ["consent", "friend", old.pubkey]] },
    ],
    [
      "two targets",
      {
        base: [
          ["-"],
          ["p", old.pubkey],
          ["p", successor.pubkey],
          ["consent", "self", old.pubkey],
        ],
      },
    ],
    [
      "two consent tags",
      {
        base: [
          ["-"],
          ["p", old.pubkey],
          ["consent", "self", old.pubkey],
          ["consent", "admin", relayKey.pubkey],
        ],
      },
    ],
    ["two replacements", { tags: [...replaced, ...replaced] }],
    ["a replacement that is not a key", { tags: [["replaced-by", "NEW"]] }],
    [
      "the archived key as its own replacement",
      { tags: [["replaced-by", old.pubkey]] },
    ],
    ["a replacement on an unarchive delta", { kind: 8003 }],
  ] as [string, Parameters<typeof delta>[2] & { tags?: string[][] }][])(
    "%s",
    async (_, { tags = replaced, ...options }) => {
      const { archives } = mount([
        ...people,
        snapshot([old.pubkey]),
        delta(old.pubkey, tags, options),
      ]);
      await waitFor(() =>
        expect(screen.getByTestId("profile-archived")).toHaveTextContent(
          "This key is archived in this community.",
        ),
      );
      // The notice says the same before its lookup answers, so ask directly.
      await expect(archives.replacement(old.pubkey)).resolves.toBeUndefined();
      expect(screen.getByTestId("profile-archived")).toHaveTextContent(
        "This key is archived in this community.",
      );
    },
  );
  it("a newer unarchive delta", async () => {
    mount([
      ...people,
      snapshot([old.pubkey]),
      delta(old.pubkey, replaced),
      delta(old.pubkey, [], { kind: 8003, created_at: 1_700_000_010 }),
    ]);
    await waitFor(() =>
      expect(screen.getByTestId("profile-archived")).toHaveTextContent(
        "This key is archived in this community.",
      ),
    );
    expect(
      screen.queryByRole("button", { name: /new key profile/ }),
    ).toBeNull();
  });
});

it("drops a replacement the next archive snapshot has not confirmed", async () => {
  const events = [
    ...people,
    snapshot([old.pubkey]),
    delta(old.pubkey, [["replaced-by", successor.pubkey]]),
  ];
  const { failing, archives } = mount(events);
  await screen.findByRole("button", { name: "Open new key profile: New Key" });

  // The archive was corrected, and the reread of its delta fails.
  events.push(
    snapshot([old.pubkey], 1_700_000_020),
    delta(old.pubkey, [], { created_at: 1_700_000_020 }),
  );
  failing.deltas = true;
  await act(() => archives.refresh());
  await waitFor(() =>
    expect(screen.getByTestId("profile-archived")).toHaveTextContent(
      "This key is archived in this community.",
    ),
  );
  expect(screen.queryByRole("button", { name: /new key profile/ })).toBeNull();
});

it("withholds the replacement when deltas at the newest second disagree", async () => {
  // Relays before strictly later delta stamps break a same-second tie by id,
  // so either delta may be the current one.
  const replaced = delta(old.pubkey, [["replaced-by", successor.pubkey]], {
    created_at: 1_700_000_030,
  });
  // The plain delta loses the NIP-01 id tie-break, so without the tie check
  // the replacement would show.
  let plain = delta(old.pubkey, [], { created_at: 1_700_000_030 });
  for (let n = 0; plain.id < replaced.id; n++)
    plain = delta(old.pubkey, [["n", String(n)]], {
      created_at: 1_700_000_030,
    });
  const { archives } = mount([
    ...people,
    snapshot([old.pubkey]),
    replaced,
    plain,
  ]);
  // The owner's own answer: the tie policy names no replacement.
  await expect(archives.replacement(old.pubkey)).resolves.toBeUndefined();
  await waitFor(() =>
    expect(screen.getByTestId("profile-archived")).toHaveTextContent(
      "This key is archived in this community.",
    ),
  );
  expect(screen.queryByRole("button", { name: /new key profile/ })).toBeNull();
});

it("retries a failed lookup after a reconnect, with an unchanged archive", async () => {
  const events = [
    ...people,
    snapshot([old.pubkey]),
    delta(old.pubkey, [["replaced-by", successor.pubkey]]),
  ];
  const { failing, archives, query, reconnect } = mount(events);
  failing.deltas = true;
  await waitFor(() =>
    expect(query.mock.calls.flatMap(([filters]) => filters)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kinds: [8002, 8003] }),
      ]),
    ),
  );
  expect(screen.getByTestId("profile-archived")).toHaveTextContent(
    "This key is archived in this community.",
  );
  const { eventId } = archives.snapshot();
  failing.deltas = false;
  reconnect();
  await screen.findByRole("button", { name: "Open new key profile: New Key" });
  expect(archives.snapshot().eventId).toBe(eventId);
});

it("reads the archive again once the connection is back, after reads failed while it was down", async () => {
  const events: RelayEvent[] = [
    ...people,
    snapshot([old.pubkey]),
    delta(old.pubkey, [["replaced-by", successor.pubkey]]),
  ];
  const { archives, failing, drop, restore, query } = mount(events);
  const snapshots = () =>
    query.mock.calls
      .flatMap(([filters]) => filters)
      .filter((filter) => filter.kinds?.includes(13535)).length;
  await screen.findByRole("button", { name: "Open new key profile: New Key" });
  // The first establishment settles access, as at startup, which starts a
  // new archive read; only a later reconnect is under test.
  const before = snapshots();
  restore();
  await waitFor(() => expect(snapshots()).toBe(before + 1));
  await waitFor(() => expect(archives.snapshot().status).toBe("ready"));
  // The drop leaves the snapshot stale, so the open profile reads it again
  // while the connection is down, and that read fails.
  failing.snapshots = true;
  drop();
  await waitFor(() => expect(archives.snapshot().status).toBe("error"));
  // Meanwhile the key is unarchived.
  events.push(
    snapshot([], 1_700_000_050),
    delta(old.pubkey, [], { kind: 8003, created_at: 1_700_000_050 }),
  );
  failing.snapshots = false;
  restore();
  await waitFor(() =>
    expect(screen.queryByTestId("profile-archived")).toBeNull(),
  );
});

it("reads a retained profile tab's archive when it is selected again, and nothing while it is hidden", async () => {
  const events: RelayEvent[] = [
    ...people,
    snapshot([old.pubkey]),
    delta(old.pubkey, [["replaced-by", successor.pubkey]]),
  ];
  const { query, archives } = mount(events, [], { tabbed: true });
  const reads = (kind: number) =>
    query.mock.calls
      .flatMap(([filters]) => filters)
      .filter((filter) => filter.kinds?.includes(kind)).length;
  const user = userEvent.setup();
  await screen.findByRole("button", { name: "Open new key profile: New Key" });
  await user.click(screen.getByRole("tab", { name: "Thread" }));
  const snapshots = reads(13535);
  const deltas = reads(8002);
  // A reread of the shared snapshot, as another profile's opening makes,
  // reads no deltas for the hidden one.
  await act(() => archives.refresh());
  await act(async () => {});
  expect(reads(8002)).toBe(deltas);
  // Another device unarchives the key, then the link returns to the tab.
  events.push(
    snapshot([], 1_700_000_050),
    delta(old.pubkey, [], { kind: 8003, created_at: 1_700_000_050 }),
  );
  // The profile names its own tab.
  await user.click(screen.getByRole("tab", { name: "Old Key" }));
  await waitFor(() =>
    expect(screen.queryByTestId("profile-archived")).toBeNull(),
  );
  expect(reads(13535)).toBe(snapshots + 2);
});

it("reads a collapsed dock's profile tab again when the dock opens, and nothing while it is collapsed", async () => {
  const events: RelayEvent[] = [
    ...people,
    snapshot([old.pubkey]),
    delta(old.pubkey, [["replaced-by", successor.pubkey]]),
  ];
  const { query, archives } = mount(events, [], { docked: true });
  const reads = (kind: number) =>
    query.mock.calls
      .flatMap(([filters]) => filters)
      .filter((filter) => filter.kinds?.includes(kind)).length;
  const user = userEvent.setup();
  await screen.findByRole("button", { name: "Open new key profile: New Key" });
  await user.click(screen.getByRole("button", { name: "Collapse" }));
  const snapshots = reads(13535);
  const deltas = reads(8002);
  await act(() => archives.refresh());
  await act(async () => {});
  expect(reads(8002)).toBe(deltas);
  // Another device unarchives the key, then the dock opens on the same tab.
  events.push(
    snapshot([], 1_700_000_050),
    delta(old.pubkey, [], { kind: 8003, created_at: 1_700_000_050 }),
  );
  await user.click(screen.getByRole("button", { name: "Expand" }));
  await waitFor(() =>
    expect(screen.queryByTestId("profile-archived")).toBeNull(),
  );
  expect(reads(13535)).toBe(snapshots + 2);
});

it("reads the archive again once the connection is back, while a read from the drop is still in flight", async () => {
  const events: RelayEvent[] = [
    ...people,
    snapshot([old.pubkey]),
    delta(old.pubkey, [["replaced-by", successor.pubkey]]),
  ];
  const { archives, failing, held, drop, restore, query } = mount(events);
  const snapshots = () =>
    query.mock.calls
      .flatMap(([filters]) => filters)
      .filter((filter) => filter.kinds?.includes(13535)).length;
  await screen.findByRole("button", { name: "Open new key profile: New Key" });
  // Settle startup access, as in the test above.
  const before = snapshots();
  restore();
  await waitFor(() => expect(snapshots()).toBe(before + 1));
  await waitFor(() => expect(archives.snapshot().status).toBe("ready"));
  // The open profile reads again while the connection is down; that read
  // will fail, but it is still in flight when the connection comes back.
  let release!: () => void;
  held.snapshots = new Promise((resolve) => {
    release = resolve;
  });
  failing.snapshots = true;
  const during = snapshots();
  drop();
  await waitFor(() => expect(snapshots()).toBe(during + 1));
  failing.snapshots = false;
  events.push(
    snapshot([], 1_700_000_050),
    delta(old.pubkey, [], { kind: 8003, created_at: 1_700_000_050 }),
  );
  restore();
  // The session acts on the reconnect in a timer; let it run first.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await act(async () => {
    delete held.snapshots;
    release();
  });
  await waitFor(() =>
    expect(screen.queryByTestId("profile-archived")).toBeNull(),
  );
  expect(archives.snapshot().status).toBe("ready");
});

it("shares one delta read among the profiles that show a key under one snapshot read", async () => {
  const { query, archives } = mount([
    ...people,
    snapshot([old.pubkey]),
    delta(old.pubkey, [["replaced-by", successor.pubkey]]),
  ]);
  const reads = () =>
    query.mock.calls
      .flatMap(([filters]) => filters)
      .filter((filter) => filter.kinds?.includes(8002)).length;
  await screen.findByRole("button", { name: "Open new key profile: New Key" });
  await waitFor(() => expect(reads()).toBe(1));
  const answers = await act(() =>
    Promise.all([
      archives.replacement(old.pubkey),
      archives.replacement(old.pubkey),
    ]),
  );
  expect(answers).toEqual([successor.pubkey, successor.pubkey]);
  expect(reads()).toBe(1);
  // A later snapshot read asks again, once.
  await act(() => archives.refresh());
  await waitFor(() => expect(reads()).toBe(2));
  await act(() => archives.replacement(old.pubkey));
  expect(reads()).toBe(2);
});

const ownedType = {
  key: "test/echo",
  title: "Echo",
  tabs: [
    {
      id: "notes",
      title: "Notes",
      component: function Notes() {
        const [dirty, setDirty] = useState(false);
        useAgentSaveState(dirty, false);
        return (
          <button type="button" onClick={() => setDirty(true)}>
            Make a change
          </button>
        );
      },
    },
  ],
};
/** The viewer's own agent for the old key, as the agents feature lists it. */
function ownedBy(viewer: string) {
  const agent = {
    key: old.pubkey,
    pubkey: old.pubkey,
    owner: viewer,
    name: "Old Agent",
    type: ownedType.key,
    place: "here",
    config: {},
    attention: {},
  } as unknown as Agent;
  const snapshot = { agents: [agent], teams: [] };
  const types = [ownedType];
  const none: never[] = [];
  return {
    subscribe: () => () => {},
    snapshot: () => snapshot,
    types: () => types,
    find: (pubkey: string) => (pubkey === old.pubkey ? agent : undefined),
    memberships: () => none,
    configHistory: () => undefined,
    addedTabs: () => none,
    registerTab: () => {},
    controlAttention: () => {},
  } as unknown as Agents;
}

it("shows an owned agent's replacement and asks before leaving unsaved edits", async () => {
  const { open, push } = mount(
    [
      ...people,
      snapshot([old.pubkey]),
      delta(old.pubkey, [["replaced-by", successor.pubkey]]),
    ],
    [],
    { ownedBy },
  );
  const user = userEvent.setup();
  await screen.findByRole("button", { name: "Open new key profile: New Key" });
  await user.click(screen.getByRole("tab", { name: "Notes" }));
  await user.click(screen.getByRole("button", { name: "Make a change" }));
  await user.click(
    screen.getByRole("button", { name: "Open new key profile: New Key" }),
  );
  await user.click(
    within(
      screen.getByRole("alertdialog", { name: "Discard changes?" }),
    ).getByRole("button", { name: "Keep editing" }),
  );
  expect(push).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Open new key profile: New Key" }),
  );
  await user.click(
    within(
      screen.getByRole("alertdialog", { name: "Discard changes?" }),
    ).getByRole("button", { name: "Discard changes" }),
  );
  // The profile's own navigation, push before open, as its other links use.
  expect(push).toHaveBeenCalledExactlyOnceWith(profileTarget(successor.pubkey));
  expect(open).not.toHaveBeenCalled();
  // Push keeps this tab, as Channels does: the discarded edits are gone, so
  // the link opens again without asking.
  await user.click(
    await screen.findByRole("button", {
      name: "Open new key profile: New Key",
    }),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(push).toHaveBeenCalledTimes(2);
});

it("hides an owned agent's notice while its name is edited", async () => {
  mount(
    [
      ...people,
      snapshot([old.pubkey]),
      delta(old.pubkey, [["replaced-by", successor.pubkey]]),
    ],
    [],
    { ownedBy },
  );
  const user = userEvent.setup();
  await screen.findByRole("button", { name: "Open new key profile: New Key" });
  await user.click(
    screen.getByRole("button", { name: "Agent profile actions" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Change name" }),
  );
  await screen.findByRole("textbox", { name: "Agent name" });
  expect(screen.getByTestId("profile-archived")).not.toBeVisible();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.getByTestId("profile-archived")).toBeVisible(),
  );
});

it("adds nothing to an owned agent's profile when its key is not archived", async () => {
  mount([...people, snapshot([])], [], { ownedBy });
  const name = await screen.findByRole("heading", { name: "Old Agent" });
  await waitFor(() =>
    expect(name.parentElement?.nextElementSibling).toBeTruthy(),
  );
  // An empty element would still take a gap in the hero's flex column.
  expect(name.parentElement?.nextElementSibling).not.toBeEmptyDOMElement();
  expect(screen.queryByTestId("profile-archived")).toBeNull();
});

it("reads an archived key's deltas once per opening", async () => {
  const { query, reopen, held } = mount([
    ...people,
    snapshot([old.pubkey]),
    delta(old.pubkey, [["replaced-by", successor.pubkey]]),
  ]);
  const reads = (kind: number) =>
    query.mock.calls
      .flatMap(([filters]) => filters)
      .filter((filter) => filter.kinds?.includes(kind)).length;
  await screen.findByRole("button", { name: "Open new key profile: New Key" });
  await waitFor(() => expect(reads(8002)).toBe(1));
  const snapshots = reads(13535);
  let release!: () => void;
  held.snapshots = new Promise((resolve) => {
    release = resolve;
  });
  try {
    reopen();
    await waitFor(() => expect(reads(13535)).toBe(snapshots + 1));
    // The reread is in flight, so the opening waits to read deltas.
    await act(async () => {});
    expect(reads(8002)).toBe(1);
  } finally {
    await act(async () => release());
  }
  await waitFor(() => expect(reads(8002)).toBe(2));
  expect(
    screen.getByRole("button", { name: "Open new key profile: New Key" }),
  ).toBeVisible();
});

it("reads the archive again when a profile opens, in both directions", async () => {
  const events: RelayEvent[] = [...people, snapshot([])];
  const { reopen } = mount(events);
  await screen.findByRole("heading", { name: "Old Key" });
  expect(screen.queryByTestId("profile-archived")).toBeNull();

  // Another device archives the key with a replacement.
  events.push(
    snapshot([old.pubkey], 1_700_000_040),
    delta(old.pubkey, [["replaced-by", successor.pubkey]], {
      created_at: 1_700_000_040,
    }),
  );
  reopen();
  await screen.findByRole("button", { name: "Open new key profile: New Key" });

  // And then unarchives it.
  events.push(
    snapshot([], 1_700_000_050),
    delta(old.pubkey, [], { kind: 8003, created_at: 1_700_000_050 }),
  );
  reopen();
  await waitFor(() =>
    expect(screen.queryByTestId("profile-archived")).toBeNull(),
  );
});

it("links the replacement when deltas at the newest second agree", async () => {
  // Concurrent publishers can sign the same state at the same second.
  const tags = [["replaced-by", successor.pubkey]];
  mount([
    ...people,
    snapshot([old.pubkey]),
    delta(old.pubkey, tags, { created_at: 1_700_000_060 }),
    delta(old.pubkey, [...tags, ["n", "1"]], { created_at: 1_700_000_060 }),
  ]);
  await screen.findByRole("button", { name: "Open new key profile: New Key" });
});

it("names no replacement when a full page of deltas shares the newest second", async () => {
  const tags = [["replaced-by", successor.pubkey]];
  const { archives } = mount([
    ...people,
    snapshot([old.pubkey]),
    ...["1", "2", "3"].map((n) =>
      delta(old.pubkey, [...tags, ["n", n]], { created_at: 1_700_000_070 }),
    ),
  ]);
  // A fourth delta at that second could disagree, unseen past the limit.
  await expect(archives.replacement(old.pubkey)).resolves.toBeUndefined();
});
