// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { profileTarget } from "../../features/profiles/target";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
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
function mount(events: RelayEvent[], extra: RelayEvent[] = []) {
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
  const owner = createRelaySession({
    viewer,
    relayAuthor: relayKey.pubkey,
    archiveAuthority: relayKey.pubkey,
    scope: "wss://relay.example.test",
    query,
    media: () => undefined,
    subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
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
    disconnect() {},
    clearCache: async () => {},
  };
  const open = vi.fn(() => true);
  render(
    <ProfilePanel
      relay={relay}
      target={profileTarget(old.pubkey) ?? ""}
      close={() => {}}
      context={{ channelId: "c", canOpen: () => true, open }}
    />,
  );
  return { query, open, failing, archives: owner.session.archives };
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
