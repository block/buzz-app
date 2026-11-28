import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, generateSecretKey, verifyEvent } from "nostr-tools";
import { createFixtureSigner } from "../browser/fixture-signer.mjs";

const wire = (event) => JSON.parse(JSON.stringify(event));
const template = (index) => ({
  kind: 9,
  tags: [
    ["h", "alpha"],
    ["ms", String(index % 27)],
  ],
  content: `primary alpha message ${index}\nMixed height message content.`,
  created_at: 1700000100 + Math.floor(index / 27),
});

test("repeated fixture signing preserves event identity and independently valid signatures", () => {
  const sign = createFixtureSigner();
  const keys = [generateSecretKey(), generateSecretKey()];
  for (let index = 0; index < 60; index++) {
    const key = keys[index % keys.length];
    const expected = wire(finalizeEvent(template(index), key));
    const event = sign(template(index), key);
    const serialized = wire(event);
    assert.equal(verifyEvent(serialized), true);
    assert.equal(verifyEvent(event), true);
    const { sig: _expectedSignature, ...expectedFields } = expected;
    const { sig: _signature, ...fields } = wire(event);
    assert.deepEqual(fields, expectedFields);
    assert.equal(
      verifyEvent({ ...wire(event), content: "tampered after signing" }),
      false,
    );
  }
});

test("separate fixture identities and mutable event payloads remain isolated", () => {
  const firstSign = createFixtureSigner();
  const secondSign = createFixtureSigner();
  const firstKey = generateSecretKey();
  const secondKey = generateSecretKey();
  const first = firstSign(template(0), firstKey);
  const second = secondSign(template(0), secondKey);
  assert.notEqual(first.pubkey, second.pubkey);
  assert.notEqual(first.id, second.id);
  first.tags[0][1] = "changed by one test";
  first.content = "changed by one test";
  const next = secondSign(template(0), secondKey);
  assert.deepEqual(wire(next).tags, template(0).tags);
  assert.equal(next.content, template(0).content);
  assert.equal(next.id, second.id);
  assert.equal(verifyEvent(wire(next)), true);
  assert.equal(verifyEvent(wire(first)), false);
});
