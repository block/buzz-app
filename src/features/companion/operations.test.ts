// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { ComposerSession } from "../messages/composer-session";
import { createCompanionOperations } from "./operations";

const MESSAGE = "b".repeat(64);
const OWN = "c".repeat(64);

function setup() {
  type Admit = { id: string; version: number };
  const react = vi.fn<(args: unknown) => Promise<Admit>>();
  const removeReactions = vi.fn<(args: unknown) => Promise<Admit>>();
  const deleteMessage = vi.fn<(args: unknown) => Promise<Admit>>();
  const edit = vi.fn<(args: unknown) => Promise<Admit>>();
  const sendToChannel = vi.fn<(args: unknown) => Promise<Admit>>();
  const retryOperation = vi.fn<(args: unknown) => Promise<undefined>>();
  const base = {
    viewer: "a".repeat(64),
    messages: {},
  } as unknown as ComposerSession;
  const session = createCompanionOperations(
    base,
    {
      react,
      removeReactions,
      deleteMessage,
      edit,
      sendToChannel,
      retryOperation,
    },
    {
      messageOf: (eventId) => (eventId === OWN ? MESSAGE : undefined),
      sourceOf: (messageId) => (messageId === MESSAGE ? "original" : undefined),
    },
  );
  const changed = vi.fn();
  session.outbox?.subscribe(changed);
  return {
    session,
    react,
    removeReactions,
    deleteMessage,
    edit,
    sendToChannel,
    retryOperation,
    changed,
  };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it("keeps one local id from request through main's delivery", async () => {
  const h = setup();
  const MAIN = "e".repeat(64);
  let settle: (a: { id: string; version: number }) => void = () => {};
  h.react.mockReturnValue(new Promise((resolve) => (settle = resolve)));
  const id = h.session.messages.react(MESSAGE, "👍");
  const [item] = h.session.outbox?.snapshot() ?? [];
  if (!item) throw new Error("pending operation");
  expect(item.event.id).toBe(id);
  expect(item.delivery).toBe("sending");
  expect(h.session.messages.reactionTarget(item.event)).toBe(MESSAGE);
  settle({ id: MAIN, version: 5 });
  await flush();
  // Admitted, but not yet delivered: still sending under the same local id.
  expect(h.session.outbox?.snapshot()[0]).toMatchObject({
    event: { id },
    delivery: "sending",
  });
  // An older projection says nothing; a newer one carrying main's id mirrors it.
  h.session.setMainOperations([], 5);
  expect(h.session.outbox?.snapshot()[0]?.event.id).toBe(id);
  h.session.setMainOperations(
    [
      {
        id: MAIN,
        messageId: MESSAGE,
        kind: 7,
        delivery: "failed",
        error: "Relay refused",
      },
    ],
    6,
  );
  expect(h.session.outbox?.snapshot()[0]).toMatchObject({
    event: { id },
    delivery: "failed",
    error: "Relay refused",
  });
  // Retry retries main's exact event.
  h.retryOperation.mockResolvedValueOnce(undefined);
  h.session.outbox?.retry(id);
  expect(h.retryOperation).toHaveBeenCalledWith({ id: MAIN });
  // Delivered: gone.
  h.session.setMainOperations(
    [{ id: MAIN, messageId: MESSAGE, kind: 7, delivery: "accepted" }],
    7,
  );
  expect(h.session.outbox?.snapshot()).toEqual([]);
});

it("treats main dropping an admitted operation from a newer projection as delivered", async () => {
  const h = setup();
  h.deleteMessage.mockResolvedValueOnce({ id: "f".repeat(64), version: 3 });
  const id = h.session.messages.deleteMessage(MESSAGE);
  await flush();
  expect(h.session.outbox?.snapshot()[0]?.event).toMatchObject({ id, kind: 5 });
  h.session.setMainOperations([], 3);
  expect(h.session.outbox?.snapshot()).toHaveLength(1);
  h.session.setMainOperations([], 4);
  expect(h.session.outbox?.snapshot()).toEqual([]);
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
  h.react.mockResolvedValueOnce({ id: "e".repeat(64), version: 1 });
  h.session.outbox?.retry(failed.event.id);
  expect(h.session.outbox?.snapshot()[0]?.delivery).toBe("sending");
  await flush();
  expect(h.react).toHaveBeenCalledTimes(2);
  h.session.setMainOperations([], 2);
  expect(h.session.outbox?.snapshot()).toEqual([]);
});

it("removes own reactions through main, naming the message they belong to", async () => {
  const h = setup();
  h.removeReactions.mockResolvedValueOnce({ id: "e".repeat(64), version: 1 });
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
  h.session.setMainOperations([], 2);
  expect(h.session.outbox?.snapshot()).toEqual([]);
});

it("shows main's admitted-but-undelivered reactions and retries that exact event through main", async () => {
  const h = setup();
  const admitted = "e".repeat(64);
  h.session.setMainOperations(
    [
      {
        id: admitted,
        messageId: MESSAGE,
        kind: 7,
        delivery: "failed",
        error: "Relay refused",
      },
    ],
    1,
  );
  const [item] = h.session.outbox?.snapshot() ?? [];
  expect(item).toMatchObject({ delivery: "failed", error: "Relay refused" });
  expect(
    h.session.messages.reactionTarget(item?.event ?? { kind: 0, tags: [] }),
  ).toBe(MESSAGE);
  h.retryOperation.mockRejectedValueOnce(
    new Error("This change can no longer be retried here."),
  );
  h.session.outbox?.retry(admitted);
  expect(h.retryOperation).toHaveBeenCalledWith({ id: admitted });
  await flush();
  expect(h.session.outbox?.snapshot()[0]?.error).toMatch(
    /no longer be retried/,
  );
  // The next projection is authoritative: a delivered reaction disappears.
  h.session.setMainOperations([], 2);
  expect(h.session.outbox?.snapshot()).toEqual([]);
});
