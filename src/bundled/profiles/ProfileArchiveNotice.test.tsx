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
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgentSaveState } from "../../features/agents/AgentSaveButton";
import type { Agent, Agents } from "../../features/agents/service";
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
 * a relay that ignores the authors filter. While `failing.deltas` is set,
 * delta reads fail. */
function mount(
  events: RelayEvent[],
  extra: RelayEvent[] = [],
  { ownedBy }: { ownedBy?: (viewer: string) => Agents } = {},
) {
  const failing = { deltas: false };
  const query = vi.fn(async (filters: readonly ReadFilter[]) =>
    filters.flatMap((filter) => {
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
    }),
  );
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
  const view = render(panel(openings));
  /** Closes the profile and opens it again in the same session. */
  const reopen = () => view.rerender(panel(++openings));
  act(() => live?.state({ status: "connected", routes: [] }));
  /** The live connection drops and comes back. */
  const reconnect = () =>
    act(() => {
      live?.state({ status: "retrying", routes: [] });
      live?.state({ status: "connected", routes: [] });
    });
  return {
    query,
    open,
    push,
    failing,
    archives: owner.session.archives,
    reconnect,
    reopen,
  };
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
  ])("%s", async (_, options) => {
    mount([
      ...people,
      snapshot([old.pubkey]),
      delta(old.pubkey, replaced, options),
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
  // The owner's own answer is the completion barrier for the negative check.
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

it("shows an owned agent's replacement and asks before leaving unsaved edits", async () => {
  const type = {
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
  const ownedBy = (viewer: string) => {
    const agent = {
      key: old.pubkey,
      pubkey: old.pubkey,
      owner: viewer,
      name: "Old Agent",
      type: type.key,
      place: "here",
      config: {},
      attention: {},
    } as unknown as Agent;
    const snapshot = { agents: [agent], teams: [] };
    const types = [type];
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
  };
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
