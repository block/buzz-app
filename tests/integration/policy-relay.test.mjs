import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { policyRelay } from "../browser/policy-relay.mjs";

test("outbound ephemeral fanout drops without subscribers while inbound injection stays strict", () => {
  const report = { unexpected: [] };
  const relay = policyRelay({ report });
  const event = { kind: 20002, content: "", tags: [["h", "alpha"]] };
  assert.doesNotThrow(() =>
    relay.publish("primary", event, { requireSubscriber: false }),
  );
  assert.throws(
    () => relay.publish("primary", event),
    /explicit production channel REQ/,
  );
  const socket = relay.socket("wss://primary.test");
  socket.routes.set("typing", [{ kinds: [20002], "#h": ["alpha"] }]);
  relay.publish("primary", event, { requireSubscriber: false });
  assert.deepEqual(report.wireFrames, [["EVENT", "typing", event]]);
  socket.close();
  assert.doesNotThrow(() =>
    relay.publish("primary", event, { requireSubscriber: false }),
  );
  assert.throws(
    () => relay.publish("primary", event),
    /explicit production channel REQ/,
  );
  assert.equal(report.wireFrames.length, 1);
});

test("a publication accepted after its page closed skips only the delivery check", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const report = { unexpected: [] };
  const accepted = [];
  const relay = policyRelay({
    report,
    acceptPublication(community, event) {
      accepted.push(event);
      relay.publish(community, event);
    },
  });
  const event = {
    id: "reaction",
    kind: 7,
    content: "+",
    tags: [["h", "alpha"]],
  };
  const socket = relay.socket("wss://primary.test");
  socket.authenticated = true;
  socket.send(JSON.stringify(["EVENT", event]));
  socket.close(); // The page closes before the acceptance timer fires.
  t.mock.timers.tick(0);
  assert.deepEqual(accepted, [event]);
  assert.deepEqual(report.unexpected, []);
  // With a socket still open in the community, delivery is checked as before.
  const open = relay.socket("wss://primary.test");
  open.authenticated = true;
  open.send(JSON.stringify(["EVENT", event]));
  assert.throws(() => t.mock.timers.tick(0), /explicit production channel REQ/);
  assert.equal(accepted.length, 2);
  // Outside an acceptance, publish stays strict even with no socket open.
  open.close();
  assert.throws(
    () => relay.publish("primary", event),
    /explicit production channel REQ/,
  );
});

// A channel head read: its top-level rows plus the relay's membership notices.
const headFilters = [
  { kinds: [9, 40002], "#h": ["alpha"], limit: 20, top_level: true },
  { kinds: [40099], "#h": ["alpha"], authors: ["relay"], limit: 500 },
];
function headRelay(answer = () => []) {
  const key = generateSecretKey();
  const report = { unexpected: [], queries: [] };
  const relay = policyRelay({ viewer: getPublicKey(key), answer, report });
  const read = (signal, filters = headFilters) => {
    const url = "https://primary.test/query";
    const body = JSON.stringify(filters);
    const auth = finalizeEvent(
      {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        content: "",
        tags: [
          ["u", url],
          ["method", "POST"],
          ["payload", createHash("sha256").update(body).digest("hex")],
        ],
      },
      key,
    );
    const token = Buffer.from(JSON.stringify(auth)).toString("base64");
    const headers = { Authorization: `Nostr ${token}` };
    return relay.fetch(url, { method: "POST", body, headers, signal });
  };
  return { relay, report, read };
}

test("a cancelled held head read rejects with its reason and is no fault", async () => {
  const { relay, report, read } = headRelay();
  relay.holdContent();
  const controller = new AbortController();
  const reason = new DOMException("left the channel", "AbortError");
  const result = read(controller.signal).then(
    () => assert.fail("a held read cannot resolve"),
    (error) => error,
  );
  // Both parts were dispatched before the caller cancels.
  await new Promise(setImmediate);
  assert.deepEqual(
    report.queries.map((query) => query.filter),
    headFilters,
  );
  controller.abort(reason);
  assert.equal(await result, reason);
  assert.deepEqual(report.unexpected, []);

  const aborted = AbortSignal.abort(reason);
  await assert.rejects(read(aborted), (error) => error === reason);
  assert.deepEqual(report.unexpected, []);
});

test("a head read still faults on errors that are not its own cancellation", async () => {
  const abortError = new DOMException("upstream", "AbortError");
  for (const error of [abortError, new Error("answer failed")]) {
    const { report, read } = headRelay((_community, filter) => {
      if (filter.kinds[0] === 40099) throw error;
      return [];
    });
    await assert.rejects(
      read(new AbortController().signal),
      (e) => e === error,
    );
    assert.ok(report.unexpected.includes(String(error)));
  }
  // An unrelated failure is recorded even when the caller has also cancelled.
  const { report, read } = headRelay();
  const mismatched = [headFilters[0], { ...headFilters[1], "#h": ["beta"] }];
  const signal = AbortSignal.abort(new Error("cancelled"));
  await assert.rejects(
    read(signal, mismatched),
    (error) => error !== signal.reason && /toEqual/.test(error.message),
  );
  assert.equal(report.unexpected.length, 1);
});

test("a head read answers each filter as its own read and flattens them", async () => {
  const { report, read } = headRelay((_community, filter) => [
    { kind: filter.kinds[0] },
  ]);
  const response = await read(new AbortController().signal);
  assert.deepEqual(await response.json(), [{ kind: 9 }, { kind: 40099 }]);
  assert.deepEqual(report.unexpected, []);
});
