import { expect, it } from "vitest";
import { createSocketPublications } from "./socket-requests";
import { keypair, signed } from "./testing";

const key = keypair();

it.each([
  // A 9034 compare-and-set refusal precedes any policy change.
  [9034, false, "conflict: artifact policy changed"],
  // Kinds without a documented compare-and-set keep `conflict:` unconfirmed.
  [9, true, undefined],
])("kind %s conflict refusal is sent=%s", async (kind, sent, reason) => {
  const publications = createSocketPublications(() => {});
  const event = signed(key, { kind, content: "", tags: [] });
  const result = publications
    .publish(event, new AbortController().signal)
    .catch((error: unknown) => error);
  const job = publications.next();
  if (!job) throw new Error("No pending publication");
  publications.dispatch(job, () => {});
  publications.receive([
    "OK",
    event.id,
    false,
    "conflict: artifact policy changed",
  ]);
  expect(await result).toMatchObject({ sent, reason });
});
