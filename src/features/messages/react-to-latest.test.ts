// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import {
  flush,
  keypair,
  message,
  roster,
  scriptedTransport,
  signed,
} from "../relay/testing";
import type { LiveCallbacks } from "../relay/live";
import type { RelayEvent } from "../relay/events";
import type { ComposerSession } from "./composer-session";
import {
  blocksReactionToggle,
  lastReactableMessage,
  toggleReaction,
} from "./react-to-latest";

const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const owners: { dispose(): void }[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});
function harness(publish = vi.fn(async (_event: RelayEvent) => {})) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: { sign: async (template) => signed(viewer, template), publish },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensure("c");
  owner.session.channels.subscribeWindow("c", () => {});
  live.receive([
    roster(relay, "c", [viewer.pubkey], 1),
    message(other, "c", "First", 2),
    message(other, "c", "Latest", 3),
  ]);
  const rows = () => owner.session.channels.window("c").rows;
  const latest = () => {
    const row = rows().at(-1);
    if (!row) throw new Error("The window has no rows");
    return row;
  };
  return { ...owner, live, publish, rows, latest };
}

it("picks the newest reactable row and skips system, agent-only and undelivered rows", () => {
  const h = harness();
  const [first, latest] = h.rows();
  if (!first || !latest) throw new Error("Expected two rows");
  expect(lastReactableMessage(h.session, h.rows())?.id).toBe(latest.id);
  expect(
    lastReactableMessage(h.session, [first, { ...latest, audience: "agents" }])
      ?.id,
  ).toBe(first.id);
  expect(
    lastReactableMessage(h.session, [
      first,
      {
        ...latest,
        membership: { type: "member_joined", actor: "a", target: "b" },
      },
    ])?.id,
  ).toBe(first.id);
  expect(
    lastReactableMessage(h.session, [
      first,
      { ...latest, huddle: { room: "r", state: "started" } },
    ])?.id,
  ).toBe(first.id);
  expect(
    lastReactableMessage(h.session, [{ ...first, delivery: "sending" }]),
  ).toBeUndefined();
  expect(
    lastReactableMessage(
      { ...h.session, outbox: undefined } as ComposerSession,
      h.rows(),
    ),
  ).toBeUndefined();
  expect(
    lastReactableMessage(
      {
        ...h.session,
        outbox: { ...h.session.outbox, supports: () => false },
      } as ComposerSession,
      h.rows(),
    ),
  ).toBeUndefined();
});

it("reacts with kind 7, records the quick reaction, then removes the own reaction", async () => {
  const h = harness();
  const target = h.latest;
  toggleReaction(h.session, "test", target(), "👍");
  await flush();
  expect(h.publish).toHaveBeenCalledTimes(1);
  const reaction = h.publish.mock.calls[0]?.[0] as RelayEvent;
  expect(reaction.kind).toBe(7);
  expect(reaction.content).toBe("👍");
  expect(reaction.tags).toContainEqual(["e", target().id]);
  expect(localStorage.getItem("buzz.quick-reactions.v1:test") ?? "").toContain(
    "👍",
  );
  h.live.receive([reaction]);
  toggleReaction(h.session, "test", target(), "👍");
  await flush();
  const removal = h.publish.mock.calls.at(-1)?.[0] as RelayEvent;
  expect(removal.kind).toBe(5);
  expect(removal.tags).toContainEqual(["e", reaction.id]);
});

it("reports a pending reaction for the row until delivery settles", async () => {
  let settle: (() => void) | undefined;
  const h = harness(
    vi.fn(
      (_event: RelayEvent) =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    ),
  );
  const target = h.latest();
  const blocked = () =>
    !!h.session.outbox
      ?.snapshot()
      .some(blocksReactionToggle(h.session, target.id));
  try {
    expect(blocked()).toBe(false);
    toggleReaction(h.session, "test", target, "👍");
    expect(blocked()).toBe(true);
    // Signing is asynchronous; wait for the publish call before settling it.
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalled());
    expect(blocked()).toBe(true);
  } finally {
    // A failure must not leave the publish promise holding the outbox open.
    settle?.();
  }
  await flush();
  expect(blocked()).toBe(false);
});
