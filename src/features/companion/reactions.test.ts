// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { ComposerSession } from "../messages/composer-session";
import { createCompanionReactions } from "./reactions";

const MESSAGE = "b".repeat(64);
const OWN = "c".repeat(64);

function setup() {
  const react = vi.fn<(args: unknown) => Promise<string>>();
  const removeReactions = vi.fn<(args: unknown) => Promise<undefined>>();
  const base = {
    viewer: "a".repeat(64),
    messages: {},
  } as unknown as ComposerSession;
  const session = createCompanionReactions(
    base,
    { react, removeReactions },
    (eventId) => (eventId === OWN ? MESSAGE : undefined),
  );
  const changed = vi.fn();
  session.outbox?.subscribe(changed);
  return { session, react, removeReactions, changed };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it("holds a reaction as pending until main admits it, then lets the projection speak", async () => {
  const h = setup();
  let settle: (id: string) => void = () => {};
  h.react.mockReturnValue(new Promise((resolve) => (settle = resolve)));
  const id = h.session.messages.react(MESSAGE, "👍");
  const [item] = h.session.outbox?.snapshot() ?? [];
  if (!item) throw new Error("pending operation");
  expect(item.delivery).toBe("sending");
  expect(h.session.messages.reactionTarget(item.event)).toBe(MESSAGE);
  expect(h.react).toHaveBeenCalledWith({
    messageId: MESSAGE,
    content: "👍",
    emoji: undefined,
  });
  settle("accepted");
  await flush();
  expect(h.session.outbox?.snapshot()).toEqual([]);
  expect(typeof id).toBe("string");
});

it("shows main's refusal as a failed operation that can be retried with the same request", async () => {
  const h = setup();
  h.react.mockRejectedValueOnce(new Error("This thread is read-only."));
  h.session.messages.react(MESSAGE, "👍");
  await flush();
  const [failed] = h.session.outbox?.snapshot() ?? [];
  if (!failed) throw new Error("failed operation");
  expect(failed).toMatchObject({
    delivery: "failed",
    error: "This thread is read-only.",
  });
  h.react.mockResolvedValueOnce("accepted");
  h.session.outbox?.retry(failed.event.id);
  expect(h.session.outbox?.snapshot()[0]?.delivery).toBe("sending");
  await flush();
  expect(h.session.outbox?.snapshot()).toEqual([]);
  expect(h.react).toHaveBeenCalledTimes(2);
});

it("removes own reactions through main, naming the message they belong to", async () => {
  const h = setup();
  h.removeReactions.mockResolvedValueOnce(undefined);
  h.session.messages.remove([OWN]);
  const [item] = h.session.outbox?.snapshot() ?? [];
  if (!item) throw new Error("pending operation");
  expect(item.event.kind).toBe(5);
  expect(h.session.messages.reactionTarget(item.event)).toBe(MESSAGE);
  expect(h.removeReactions).toHaveBeenCalledWith({
    messageId: MESSAGE,
    ids: [OWN],
  });
  expect(() => h.session.messages.remove(["d".repeat(64)])).toThrow(
    /Load the reaction/,
  );
  await flush();
  expect(h.session.outbox?.snapshot()).toEqual([]);
});
