// Local-only cold/warm send diagnostic using real IndexedDB and ephemeral keys.
import {
  browserOutboxStorage,
  createOutbox,
  type OutgoingEvent,
} from "../../src/features/relay/outbox";
import { createRelayProfiler } from "../../src/features/relay/profiling";
import { keypair, signed } from "../../src/features/relay/testing";
const result = document.getElementById("result");
if (!result) throw new Error("Missing diagnostic output");
const scope = `fixture:startup:${crypto.randomUUID()}`;
const storage = browserOutboxStorage(scope);
let owner: ReturnType<typeof createOutbox> | undefined;
let closed: Promise<void> | undefined;
try {
  const viewer = keypair();
  const records: OutgoingEvent[] = [];
  for (let index = 0; index < 512; index++) {
    const event = signed(viewer, {
      kind: 9,
      content: `Retained ${index}`,
      tags: [["h", "fixture"]],
    });
    records.push({ event, signed: event, delivery: "seen" });
  }
  await storage.load();
  await storage.save(records);
  storage.close?.();
  const profiling = createRelayProfiler();
  let accepted = () => {};
  const journal = browserOutboxStorage(scope);
  let onClose = () => {};
  closed = new Promise<void>((resolve) => {
    onClose = resolve;
  });
  owner = createOutbox(
    viewer.pubkey,
    {
      sign: async (event) => signed(viewer, event),
      publish: async () => {},
    },
    {
      ...journal,
      close() {
        journal.close?.();
        onClose();
      },
    },
    { profiling, onAccepted: () => accepted() },
  );
  const outbox = owner.outbox;
  const send = async (content: string) => {
    const start = performance.now();
    let unsubscribe = () => {};
    const done = new Promise<void>((resolve, reject) => {
      accepted = resolve;
      const id = outbox.send({ kind: 9, content, tags: [["h", "fixture"]] });
      unsubscribe = outbox.subscribe(() => {
        const item = outbox
          .snapshot()
          .find((operation) => operation.event.id === id);
        if (item?.delivery === "failed" || item?.delivery === "unknown")
          reject(new Error(item.error ?? "Fixture delivery failed"));
      });
    });
    try {
      await done;
    } finally {
      unsubscribe();
    }
    return performance.now() - start;
  };
  const coldMs = await send("First send during journal hydration");
  const warmMs = await send("Second send after hydration");
  result.textContent = JSON.stringify(
    {
      restoredEvents: records.length,
      coldMs,
      warmMs,
      timings: profiling
        .snapshot()
        .filter((sample) =>
          ["outbox.load", "send.sign", "send.publish"].includes(sample.stage),
        ),
    },
    null,
    2,
  );
} catch (error) {
  result.textContent = `FAIL: ${String(error)}`;
} finally {
  owner?.dispose();
  storage.close?.();
  // Wait for the owner's last durable commit before removing this fixture's records.
  await closed;
  const cleanup = browserOutboxStorage(scope);
  try {
    await cleanup.load();
    await cleanup.save([]);
  } finally {
    cleanup.close?.();
  }
}
