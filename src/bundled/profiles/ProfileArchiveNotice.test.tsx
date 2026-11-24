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
import { keypair, profile, signed } from "../../features/relay/testing";
import { ProfilePanel } from "./ProfilePanel";

const relayKey = keypair();
const old = keypair();
const successor = keypair();
const owners: { dispose(): void }[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
});

/** The relay's archive list: a bare key, or a key and its replacement. */
function snapshot(entries: (string | string[])[], created_at?: number) {
  return signed(relayKey, {
    kind: 13535,
    content: "",
    tags: [
      ["-"],
      ...entries.map((entry) => [
        "p",
        ...(Array.isArray(entry) ? entry : [entry]),
      ]),
    ],
    ...(created_at && { created_at }),
  });
}
/** A relay archive delta that names a replacement. */
function delta(target: string, next: string) {
  return signed(relayKey, {
    kind: 8002,
    content: "",
    tags: [
      ["-"],
      ["p", target],
      ["consent", "self", target],
      ["replaced-by", next],
    ],
  });
}
/** `extra` events answer every filter of their kind, whatever its authors:
 * a relay that ignores the authors filter. While `failing.snapshots` is
 * set, snapshot reads fail. While `held.snapshots` is
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
  const failing = { snapshots: false };
  const held: { snapshots?: Promise<void> } = {};
  const query = vi.fn(async (filters: readonly ReadFilter[]) => {
    const snapshots = filters.some((filter) => filter.kinds?.includes(13535));
    // A read that starts while failing fails, also after it is held.
    const fails = snapshots && failing.snapshots;
    if (snapshots && held.snapshots) await held.snapshots;
    if (fails) throw new Error("relay unavailable");
    return filters.flatMap((filter) => {
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
  return {
    query,
    open,
    push,
    failing,
    held,
    archives: owner.session.archives,
    drop,
    restore,
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

const snapshotReads = (query: ReturnType<typeof mount>["query"]) =>
  query.mock.calls
    .flatMap(([filters]) => filters)
    .filter((filter) => filter.kinds?.includes(13535)).length;

it("links an archived key's replacement from the relay's archive snapshot", async () => {
  const { open, query } = mount([
    ...people,
    snapshot([[old.pubkey, successor.pubkey]]),
  ]);
  const link = await screen.findByRole("button", {
    name: "Open new key profile: New Key",
  });
  expect(screen.getByTestId("profile-archived")).toHaveTextContent(
    "This key was replaced by New Key.",
  );
  await userEvent.setup().click(link);
  expect(open).toHaveBeenCalledWith(profileTarget(successor.pubkey));
  // The snapshot is the only archive read.
  expect(
    query.mock.calls
      .flatMap(([filters]) => filters)
      .filter((filter) =>
        filter.kinds?.some((kind) => kind === 8002 || kind === 8003),
      ),
  ).toEqual([]);
});

it("names no replacement when the snapshot names none, even if a delta does", async () => {
  // An older relay lists bare keys; its deltas can be late or obsolete.
  mount([
    ...people,
    snapshot([old.pubkey]),
    delta(old.pubkey, successor.pubkey),
  ]);
  await waitFor(() =>
    expect(screen.getByTestId("profile-archived")).toHaveTextContent(
      "This key is archived in this community.",
    ),
  );
  expect(screen.queryByRole("button", { name: /new key profile/ })).toBeNull();
});

it("shows nothing for a key that is not archived", async () => {
  const { query } = mount([...people, snapshot([])]);
  await screen.findByRole("heading", { name: "Old Key" });
  await waitFor(() => expect(snapshotReads(query)).toBeGreaterThan(0));
  await waitFor(() =>
    expect(screen.queryByTestId("profile-archived")).toBeNull(),
  );
});

describe("names no replacement for a snapshot entry NIP-IA says to ignore", () => {
  const other = keypair().pubkey;
  it.each([
    ["a replacement that is not a key", [[old.pubkey, "NEW"]]],
    ["the archived key as its own replacement", [[old.pubkey, old.pubkey]]],
    [
      "two entries that disagree",
      [
        [old.pubkey, successor.pubkey],
        [old.pubkey, other],
      ],
    ],
    [
      "an entry with and one without a replacement",
      [[old.pubkey, successor.pubkey], old.pubkey],
    ],
  ] as [string, (string | string[])[]][])("%s", async (_, entries) => {
    const { archives } = mount([...people, snapshot(entries)]);
    await waitFor(() => expect(archives.snapshot().status).toBe("ready"));
    expect(screen.getByTestId("profile-archived")).toHaveTextContent(
      "This key is archived in this community.",
    );
  });
});

it("follows the archive's next snapshot", async () => {
  const events = [...people, snapshot([old.pubkey])];
  const { archives } = mount(events);
  await waitFor(() =>
    expect(screen.getByTestId("profile-archived")).toHaveTextContent(
      "This key is archived in this community.",
    ),
  );
  // A replacement is added to the archived key.
  events.push(snapshot([[old.pubkey, successor.pubkey]], 1_700_000_020));
  await act(() => archives.refresh());
  await screen.findByRole("button", { name: "Open new key profile: New Key" });
  // It is unarchived and archived again with no replacement.
  events.push(snapshot([old.pubkey], 1_700_000_030));
  await act(() => archives.refresh());
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: /new key profile/ }),
    ).toBeNull(),
  );
  expect(screen.getByTestId("profile-archived")).toHaveTextContent(
    "This key is archived in this community.",
  );
});

it("keeps the last known notice, with its link, while a reread fails", async () => {
  // As every archive surface does: the entry and its replacement are one state.
  const { archives, failing } = mount([
    ...people,
    snapshot([[old.pubkey, successor.pubkey]]),
  ]);
  await screen.findByRole("button", { name: "Open new key profile: New Key" });
  failing.snapshots = true;
  await act(() => archives.refresh());
  await waitFor(() => expect(archives.snapshot().status).toBe("error"));
  expect(
    screen.getByRole("button", { name: "Open new key profile: New Key" }),
  ).toBeVisible();
});

it("reads the archive again once the connection is back", async () => {
  const events: RelayEvent[] = [
    ...people,
    snapshot([[old.pubkey, successor.pubkey]]),
  ];
  const { archives, drop, restore } = mount(events);
  await screen.findByRole("button", { name: "Open new key profile: New Key" });
  restore();
  await waitFor(() => expect(archives.snapshot().status).toBe("ready"));
  drop();
  // The key is unarchived while the connection is down.
  events.push(snapshot([], 1_700_000_050));
  restore();
  await waitFor(() =>
    expect(screen.queryByTestId("profile-archived")).toBeNull(),
  );
});

it("reads the archive again once the connection is back, after a read while it was down succeeded", async () => {
  const events: RelayEvent[] = [
    ...people,
    snapshot([[old.pubkey, successor.pubkey]]),
  ];
  const { archives, drop, restore, reopen, query } = mount(events);
  await screen.findByRole("button", { name: "Open new key profile: New Key" });
  restore();
  await waitFor(() => expect(archives.snapshot().status).toBe("ready"));
  // Reads go over a separate path, so a profile opened while the live
  // connection is down can still read; a change after it was missed.
  drop();
  const during = snapshotReads(query);
  reopen();
  await waitFor(() => expect(snapshotReads(query)).toBe(during + 1));
  await waitFor(() => expect(archives.snapshot().status).toBe("ready"));
  events.push(snapshot([], 1_700_000_050));
  restore();
  await waitFor(() =>
    expect(screen.queryByTestId("profile-archived")).toBeNull(),
  );
});

it("reads the archive again once the connection is back, while a read from the drop is still in flight", async () => {
  const events: RelayEvent[] = [
    ...people,
    snapshot([[old.pubkey, successor.pubkey]]),
  ];
  const { archives, failing, held, drop, restore, reopen, query } =
    mount(events);
  await screen.findByRole("button", { name: "Open new key profile: New Key" });
  restore();
  await waitFor(() => expect(archives.snapshot().status).toBe("ready"));
  // A profile opened while the connection is down reads; that read will
  // fail, but it is still in flight when the connection comes back.
  let release!: () => void;
  held.snapshots = new Promise((resolve) => {
    release = resolve;
  });
  failing.snapshots = true;
  drop();
  const during = snapshotReads(query);
  reopen();
  await waitFor(() => expect(snapshotReads(query)).toBe(during + 1));
  failing.snapshots = false;
  events.push(snapshot([], 1_700_000_050));
  restore();
  await act(async () => {
    delete held.snapshots;
    release();
  });
  await waitFor(() =>
    expect(screen.queryByTestId("profile-archived")).toBeNull(),
  );
  expect(archives.snapshot().status).toBe("ready");
});

it("reads a retained profile tab's archive when it is selected again, and nothing while it is hidden", async () => {
  const events: RelayEvent[] = [
    ...people,
    snapshot([[old.pubkey, successor.pubkey]]),
  ];
  const { query, archives } = mount(events, [], { tabbed: true });
  const user = userEvent.setup();
  await screen.findByRole("button", { name: "Open new key profile: New Key" });
  await waitFor(() => expect(archives.snapshot().status).toBe("ready"));
  await user.click(screen.getByRole("tab", { name: "Thread" }));
  const hidden = snapshotReads(query);
  // Another device unarchives the key, then the profile's tab is selected.
  events.push(snapshot([], 1_700_000_050));
  await act(async () => {});
  expect(snapshotReads(query)).toBe(hidden);
  // The profile names its own tab.
  await user.click(screen.getByRole("tab", { name: "Old Key" }));
  await waitFor(() =>
    expect(screen.queryByTestId("profile-archived")).toBeNull(),
  );
  expect(snapshotReads(query)).toBe(hidden + 1);
});

it("reads a collapsed dock's profile tab again when the dock opens, and nothing while it is collapsed", async () => {
  const events: RelayEvent[] = [
    ...people,
    snapshot([[old.pubkey, successor.pubkey]]),
  ];
  const { query, archives } = mount(events, [], { docked: true });
  const user = userEvent.setup();
  await screen.findByRole("button", { name: "Open new key profile: New Key" });
  await waitFor(() => expect(archives.snapshot().status).toBe("ready"));
  await user.click(screen.getByRole("button", { name: "Collapse" }));
  const hidden = snapshotReads(query);
  // Another device unarchives the key, then the dock opens on the same tab.
  events.push(snapshot([], 1_700_000_050));
  await act(async () => {});
  expect(snapshotReads(query)).toBe(hidden);
  await user.click(screen.getByRole("button", { name: "Expand" }));
  await waitFor(() =>
    expect(screen.queryByTestId("profile-archived")).toBeNull(),
  );
  expect(snapshotReads(query)).toBe(hidden + 1);
});

it("reads the archive again when a profile opens, in both directions", async () => {
  const events: RelayEvent[] = [...people, snapshot([])];
  const { reopen } = mount(events);
  await screen.findByRole("heading", { name: "Old Key" });
  expect(screen.queryByTestId("profile-archived")).toBeNull();

  // Another device archives the key with a replacement.
  events.push(snapshot([[old.pubkey, successor.pubkey]], 1_700_000_040));
  reopen();
  await screen.findByRole("button", { name: "Open new key profile: New Key" });

  // And then unarchives it.
  events.push(snapshot([], 1_700_000_050));
  reopen();
  await waitFor(() =>
    expect(screen.queryByTestId("profile-archived")).toBeNull(),
  );
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
    [...people, snapshot([[old.pubkey, successor.pubkey]])],
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
  mount([...people, snapshot([[old.pubkey, successor.pubkey]])], [], {
    ownedBy,
  });
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
