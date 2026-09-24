import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { PublishRejected } from "../relay/outbox";
import { matchesEvent } from "../relay/projection";
import { keypair, roster, signed } from "../relay/testing";
import type { RelayEvent } from "../relay/events";
import { addChannelMember, canAddMembers } from "./members";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function setup(type = "stream") {
  const viewer = keypair(),
    relay = keypair(),
    person = keypair();
  const id = "11111111-1111-4111-8111-111111111111";
  let members = [viewer.pubkey];
  let clock = 1700000000;
  let fail = "";
  let apply = true;
  let foreign = false;
  let agent = false;
  const publish = vi.fn(async (event: RelayEvent) => {
    if (fail) throw new PublishRejected(fail);
    if (apply) members = [...new Set([...members, person.pubkey])];
    clock++;
    return event;
  });
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      readAgentLibrary: async () => ({
        definitions: [],
        identities: agent ? [{ pubkey: person.pubkey, name: "Agent" }] : [],
      }),
      writer: {
        kinds: [9, 9000],
        sign: async (template) => signed(viewer, template),
        publish: async (event) => {
          await publish(event);
        },
      },
      query: async (filters) =>
        [
          signed(relay, {
            kind: 39000,
            content: "",
            tags: [["d", id], ["t", type], ["private"], ["name", "Design"]],
          }),
          roster(foreign ? person : relay, id, members, clock),
        ].filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
    },
    { outboxStorage: { load: () => [], save: () => {} } },
  );
  cleanups.push(owner.dispose);
  return {
    ...owner,
    id,
    person,
    viewer,
    publish,
    setFail: (value: string) => {
      fail = value;
    },
    setApply: (value: boolean) => {
      apply = value;
    },
    setForeign: () => {
      foreign = true;
    },
    removeViewer: () => {
      members = [];
      clock++;
    },
    setAgent: async () => {
      agent = true;
      await owner.session.agentChoices.refresh();
    },
    async ready() {
      owner.session.channels.ensureList();
      await vi.waitFor(() =>
        expect(owner.session.channels.list().status).toBe("ready"),
      );
    },
    add: (signal = new AbortController().signal) =>
      addChannelMember(owner.session, id, person.pubkey, signal),
  };
}
it("adds a person without changing roles and confirms the live roster using membership capability alone", async () => {
  const t = setup();
  await t.ready();
  await t.add();
  expect(t.publish).toHaveBeenCalledOnce();
  expect(t.publish.mock.calls[0]?.[0].tags).toEqual(
    expect.arrayContaining([
      ["h", t.id],
      ["p", t.person.pubkey],
    ]),
  );
  expect(
    t.publish.mock.calls[0]?.[0].tags.some(([tag]) => tag === "role"),
  ).toBe(false);
  expect(t.session.channels.list().channels[0]?.members).toContain(
    t.person.pubkey,
  );
  await t.add();
  expect(t.publish).toHaveBeenCalledOnce();
});
it("uses the bot role for an existing library agent", async () => {
  const t = setup();
  await t.ready();
  await t.setAgent();
  await t.add();
  expect(t.publish.mock.calls[0]?.[0].tags).toContainEqual(["role", "bot"]);
});
it("preserves a rejected operation and retries its exact identity", async () => {
  const t = setup();
  await t.ready();
  t.setFail("This agent only accepts additions from its owner");
  await expect(t.add()).rejects.toThrow(/only accepts/);
  const first = t.publish.mock.calls[0]?.[0].id;
  expect(t.session.channels.list().channels[0]?.members).not.toContain(
    t.person.pubkey,
  );
  t.setFail("");
  await t.add();
  expect(t.publish.mock.calls[1]?.[0].id).toBe(first);
});
it("does not claim an accepted write is confirmed membership", async () => {
  const t = setup();
  await t.ready();
  t.setApply(false);
  await expect(t.add()).rejects.toThrow(/not confirmed in the member list/);
});
it("rejects stale permission and foreign roster evidence before publishing", async () => {
  const t = setup();
  await t.ready();
  t.setForeign();
  await expect(t.add()).rejects.toThrow(/refresh channel membership/);
  expect(t.publish).not.toHaveBeenCalled();
  const revoked = setup();
  await revoked.ready();
  revoked.removeViewer();
  await expect(revoked.add()).rejects.toThrow();
  expect(revoked.publish).not.toHaveBeenCalled();
});
it.each(["dm", "unknown"])("never expands a %s conversation", async (type) => {
  const t = setup(type);
  await t.ready();
  expect(canAddMembers(t.session, t.session.channels.list().channels[0])).toBe(
    false,
  );
  await expect(t.add()).rejects.toThrow(/cannot add/);
  expect(t.publish).not.toHaveBeenCalled();
});
it("cancellation before intent and session disposal never publish", async () => {
  const t = setup();
  await t.ready();
  const cancel = new AbortController();
  cancel.abort();
  await expect(t.add(cancel.signal)).rejects.toThrow();
  t.dispose();
  await expect(t.add()).rejects.toThrow();
  expect(t.publish).not.toHaveBeenCalled();
});
