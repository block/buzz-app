// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { afterEach, expect, it } from "vitest";
import type { ChannelList, ChannelSummary } from "../relay/contracts";
import { createMemberAdministration } from "./administration";
import { useChannelGuests, useChannelRoles } from "./guests";

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

function relay(
  members: readonly string[],
  agentRole?: "guest" | "bot",
  { hold = false } = {},
) {
  let clock = 100;
  let reads = 0;
  // A held read answers with the roles it saw when it began.
  const held: (() => void)[] = [];
  const record = (kind: number, tags: string[][]) =>
    finalizeEvent({ kind, tags, content: "", created_at: clock++ }, relayKey);
  let channel: ChannelSummary = {
    id,
    name: "launch",
    channelType: "stream",
    members,
    ...(agentRole === "guest" ? { guests: [agent] } : {}),
    cached: true,
  } as ChannelSummary;
  let roles: [string, string][] = [[viewer, "owner"]];
  if (agentRole) roles.push([agent, agentRole]);
  let list: ChannelList = { status: "ready", channels: [channel] } as never;
  const listeners = new Set<() => void>();
  const owner = createMemberAdministration({
    reader: {
      read: async () => {
        reads++;
        const seen = roles;
        if (hold) await new Promise<void>((resolve) => held.push(resolve));
        return [
          record(39000, [["d", id], ["t", "stream"], ["private"]]),
          record(39001, [
            ["d", id],
            ["p", viewer, "owner"],
          ]),
          record(39002, [
            ["d", id],
            ...seen.map(([key, role]) => ["p", key, "", role]),
          ]),
        ];
      },
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
    reads: () => reads,
    /** Another consumer, such as the members panel, reads roles. */
    readElsewhere: () => owner.capability.refresh(id),
    /** Answers the oldest held read. */
    release: () => held.shift()?.(),
    holding: () => held.length,
    /** Stops holding: later reads answer at once. */
    unhold: () => {
      hold = false;
    },
    /** The relay confirms the downloaded membership. */
    confirm: () => publish({}),
    /** Another device changes the agent's role; the members stay the same,
     * and the signed roster's Guests follow it, as discovery lists them. */
    setRole: (role: "guest" | "bot") => {
      roles = [...roles.filter(([key]) => key !== agent), [agent, role]];
      publish({ guests: role === "guest" ? [agent] : [] });
    },
    /** The agent joins as a guest while the channel is open. */
    addGuest: () => {
      roles = [...roles, [agent, "guest"]];
      publish({
        members: [...(channel.members ?? []), agent],
        guests: [agent],
      });
    },
  };
}

it("shows a guest once the relay confirms a cold channel's membership", async () => {
  const h = relay([viewer, agent], "guest");
  const { result } = renderHook(() => useChannelGuests(h.session, id));
  // A downloaded roster isn't confirmed yet: no guests.
  expect(result.current.size).toBe(0);
  h.confirm();
  await waitFor(() => expect([...result.current]).toEqual([agent]));
  // Guests come from the signed roster in the list, not a role read.
  expect(h.reads()).toBe(0);
});

it("shows an agent that joins as a guest while the chooser is open", async () => {
  const h = relay([viewer]);
  h.confirm();
  const { result } = renderHook(() => useChannelGuests(h.session, id));
  expect(result.current.size).toBe(0);
  h.addGuest();
  await waitFor(() => expect([...result.current]).toEqual([agent]));
});

it("follows another device changing only the agent's role", async () => {
  const h = relay([viewer, agent], "bot");
  h.confirm();
  const { result } = renderHook(() => useChannelGuests(h.session, id));
  expect(result.current.size).toBe(0);
  h.setRole("guest");
  await waitFor(() => expect([...result.current]).toEqual([agent]));
  h.setRole("bot");
  await waitFor(() => expect(result.current.size).toBe(0));
});

it("shows a Guest while the composer's own role read still holds the older roles", async () => {
  const h = relay([viewer, agent], "bot", { hold: true });
  h.confirm();
  const { result } = renderHook(() => {
    useChannelRoles(h.session, id);
    return useChannelGuests(h.session, id);
  });
  // The composer's read has seen the agent as bot and is still under way.
  await waitFor(() => expect(h.holding()).toBe(1));
  h.setRole("guest");
  await waitFor(() => expect([...result.current]).toEqual([agent]));
  h.release();
  await waitFor(() => expect(h.status()).toBe("ready"));
  expect([...result.current]).toEqual([agent]);
});

it("shows a Guest when another consumer's read began before the role changed", async () => {
  const h = relay([viewer, agent], "bot", { hold: true });
  h.confirm();
  // Another consumer's read, such as the members panel's, sees the agent as
  // bot and is still under way when the role changes and the chooser mounts.
  const elsewhere = h.readElsewhere();
  await waitFor(() => expect(h.holding()).toBe(1));
  h.setRole("guest");
  const { result, unmount } = renderHook(() => useChannelGuests(h.session, id));
  await waitFor(() => expect([...result.current]).toEqual([agent]));
  h.release();
  await elsewhere;
  expect([...result.current]).toEqual([agent]);
  unmount();
  const again = renderHook(() => useChannelGuests(h.session, id));
  expect([...again.result.current]).toEqual([agent]);
});

it("reads roles once the relay confirms the roster, and again only when its members change", async () => {
  const h = relay([viewer]);
  const first = renderHook(() => useChannelRoles(h.session, id));
  // Role reads fail until the relay confirms downloaded membership.
  expect(h.reads()).toBe(0);
  h.confirm();
  await waitFor(() => expect(h.status()).toBe("ready"));
  expect(h.reads()).toBe(1);
  // The composer remounts often; the same roster isn't read again.
  first.unmount();
  renderHook(() => useChannelRoles(h.session, id));
  expect(h.reads()).toBe(1);
  h.addGuest();
  await waitFor(() => expect(h.reads()).toBe(2));
});
