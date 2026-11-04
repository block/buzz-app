// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
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

function snapshot(keys: string[]) {
  return signed(relayKey, {
    kind: 13535,
    content: "",
    tags: [["-"], ...keys.map((key) => ["p", key])],
  });
}
function delta(target: string, tags: string[][], by: Key = relayKey) {
  return signed(by, {
    kind: 8002,
    content: "",
    tags: [
      ["-"],
      ["p", target],
      ["consent", "self", target],
      ["reason", "rotated"],
      ...tags,
    ],
  });
}
/** `extra` events answer every filter of their kind, whatever its authors:
 * a relay that ignores the authors filter. */
function mount(events: RelayEvent[], extra: RelayEvent[] = []) {
  const query = vi.fn(async (filters: readonly ReadFilter[]) =>
    filters.flatMap((filter) =>
      events
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
        .concat(extra.filter((event) => filter.kinds?.includes(event.kind))),
    ),
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
  return { query, open };
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
    [delta(old.pubkey, [["replaced-by", successor.pubkey]], keypair())],
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
