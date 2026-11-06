import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
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

test("an unread window or authored read is answered at a lone filter's split limit, and refused at that limit beside another window", async () => {
  const report = { unexpected: [], queries: [] };
  const key = generateSecretKey();
  const viewer = getPublicKey(key);
  const relay = policyRelay({
    viewer,
    answer: () => [],
    report,
  });
  const window = (channel, limit) => ({
    kinds: [9, 40002, 40008],
    "#h": [channel],
    since: 1000,
    include_aux: true,
    limit,
  });
  // The viewer's newest page, and a walk page back through their history.
  const authored = (limit) => ({
    kinds: [9, 40002, 40008],
    authors: [viewer],
    include_aux: true,
    limit,
  });
  const walk = (limit) => ({
    ...authored(limit),
    until: 1000,
    before_id: "0".repeat(64),
  });
  const read = (filters) => {
    const url = "https://primary.test/query";
    const body = JSON.stringify(filters);
    const auth = finalizeEvent(
      {
        kind: 27235,
        created_at: 0,
        content: "",
        tags: [
          ["u", url],
          ["payload", createHash("sha256").update(body).digest("hex")],
        ],
      },
      key,
    );
    const token = Buffer.from(JSON.stringify(auth)).toString("base64");
    return relay.fetch(url, {
      body,
      headers: { Authorization: `Nostr ${token}` },
    });
  };
  // The reader halves a lone filter's limit while its page comes back over
  // the byte budget: a window's 24 → 12 → 6 → 3 → 1, the authored page's
  // 100 → 50 → 25 → 12 → 6 → 3 → 1, and a walk page's 500 → 250 → 125 → 62
  // → 31 → 15 → 7 → 3 → 1, which the next walk page keeps.
  for (const filters of [
    ...[12, 1, 20, 100].map((limit) => [window("alpha", limit)]),
    [window("alpha", 20), window("beta", 100)],
    ...[100, 50, 25, 1].map((limit) => [authored(limit)]),
    [authored(100), window("alpha", 20)],
    ...[500, 250, 62, 1].map((limit) => [walk(limit)]),
  ])
    assert.deepEqual(await (await read(filters)).json(), []);
  const refused = [
    [window("alpha", 12), window("beta", 12)],
    [window("alpha", 0)],
    [window("alpha", 101)],
    ...[0, 75, 101].map((limit) => [authored(limit)]),
    [authored(50), window("alpha", 20)],
    ...[0, 300, 501].map((limit) => [walk(limit)]),
    [walk(500), window("alpha", 20)],
  ];
  for (const filters of refused)
    await assert.rejects(read(filters), /limit|expect/i);
  assert.equal(report.unexpected.length, refused.length);
});
