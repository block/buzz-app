// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { afterEach, expect, it } from "vitest";
import type { ChannelList, ChannelSummary } from "../relay/contracts";
import { createMemberAdministration } from "./administration";
import { useChannelGuests } from "./guests";

// Roles come from the real role reader over relay-signed rosters, and access
// follows the channel list the way the session's does: downloaded membership
// is display-only, so role reads fail until the relay confirms it.
const relayKey = new Uint8Array(32).fill(3);
const author = getPublicKey(relayKey);
const viewer = getPublicKey(new Uint8Array(32).fill(2));
const agent = getPublicKey(new Uint8Array(32).fill(4));
const id = "11111111-1111-4111-8111-111111111111";
const stops: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
});

function relay(members: readonly string[], agentRole?: "guest") {
  let clock = 100;
  const record = (kind: number, tags: string[][]) =>
    finalizeEvent({ kind, tags, content: "", created_at: clock++ }, relayKey);
  let channel: ChannelSummary = {
    id,
    name: "launch",
    channelType: "stream",
    members,
    cached: true,
  } as ChannelSummary;
  let roles: [string, string][] = [[viewer, "owner"]];
  if (agentRole) roles.push([agent, agentRole]);
  let list: ChannelList = { status: "ready", channels: [channel] } as never;
  const listeners = new Set<() => void>();
  const owner = createMemberAdministration({
    reader: {
      read: async () => [
        record(39000, [["d", id], ["t", "stream"], ["private"]]),
        record(39001, [
          ["d", id],
          ["p", viewer, "owner"],
        ]),
        record(39002, [
          ["d", id],
          ...roles.map(([key, role]) => ["p", key, "", role]),
        ]),
      ],
    },
    viewer,
    relayAuthor: author,
    canAccess: () => !channel.cached,
    acceptDiscovery: () => {},
  });
  stops.push(owner.dispose);
  const publish = (next: Partial<ChannelSummary>) => {
    const { cached: _cached, ...rest } = channel;
    channel = { ...rest, ...next } as ChannelSummary;
    list = { ...list, channels: [channel] };
    for (const listener of listeners) listener();
  };
  return {
    session: {
      memberAdministration: owner.capability,
      channels: {
        list: () => list,
        subscribeList: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    } as never,
    status: () => owner.capability.snapshot(id).status,
    /** The relay confirms the downloaded membership. */
    confirm: () => publish({}),
    /** The agent joins as a guest while the channel is open. */
    addGuest: () => {
      roles = [...roles, [agent, "guest"]];
      publish({ members: [...(channel.members ?? []), agent] });
    },
  };
}

it("shows a guest once the relay confirms a cold channel's membership", async () => {
  const h = relay([viewer, agent], "guest");
  const { result } = renderHook(() => useChannelGuests(h.session, id));
  // The cached roster can't be read yet: no guests, and no stuck read.
  await waitFor(() => expect(h.status()).not.toBe("loading"));
  expect(result.current.size).toBe(0);
  h.confirm();
  await waitFor(() => expect([...result.current]).toEqual([agent]));
});

it("rereads roles when an agent joins as a guest after they were read", async () => {
  const h = relay([viewer]);
  h.confirm();
  const { result } = renderHook(() => useChannelGuests(h.session, id));
  await waitFor(() => expect(h.status()).toBe("ready"));
  expect(result.current.size).toBe(0);
  h.addGuest();
  await waitFor(() => expect([...result.current]).toEqual([agent]));
});
