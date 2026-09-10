import { browserOutboxStorage } from "../../src/features/relay/outbox-storage";
import { keypair, signed } from "../../src/features/relay/testing";
import type { OutgoingEvent } from "../../src/features/relay/outbox";
const result = document.getElementById("result");
if (!result) throw new Error("Missing diagnostic output");
const scope = `fixture:${crypto.randomUUID()}`;
const stores: ReturnType<typeof browserOutboxStorage>[] = [];
const open = (partition = scope) => {
  const store = browserOutboxStorage(partition);
  stores.push(store);
  return store;
};
const assert = (condition: boolean, label: string) => {
  if (!condition) throw new Error(label);
};
try {
  const viewer = keypair();
  const event = signed(viewer, {
    kind: 9,
    content: "local storage fixture",
    tags: [["h", "fixture"]],
  });
  const pending: OutgoingEvent = { event, signed: event, delivery: "unknown" };
  localStorage.setItem(`buzz-outbox-v1:${scope}`, JSON.stringify([pending]));
  const first = open();
  const legacy = await first.load();
  assert(legacy.length === 1, "migrate legacy intent");
  await first.save(legacy);
  const second = open();
  assert(
    (await second.load())[0]?.event.id === event.id,
    "restore exact signed ID",
  );
  await second.save([{ ...pending, delivery: "seen" }]);
  const third = open();
  assert(
    (await third.load())[0]?.delivery === "seen",
    "persist confirmation incrementally",
  );
  await third.save([]);
  const empty = open();
  assert(
    (await empty.load()).length === 0,
    "deleted entries must not resurrect from legacy storage",
  );
  assert(
    (await open(`${scope}:other`).load()).length === 0,
    "partition isolation",
  );
  result.textContent =
    "PASS: legacy migration, exact signed restore, incremental confirmation, deletion after restart, partition isolation";
} catch (error) {
  result.textContent = `FAIL: ${String(error)}`;
} finally {
  for (const store of stores) store.close?.();
  localStorage.removeItem(`buzz-outbox-v1:${scope}`);
}
