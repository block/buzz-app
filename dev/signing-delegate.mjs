import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { finalizeEvent } from "nostr-tools";

/** Local implementation of the broker's asynchronous signing/publication delegate.
 * The broker selects a delegate with { relay, identity } for each request. A
 * future remote implementation can replace signing and publication independently;
 * validation, admission and receipt handling remain with their existing owners.
 * `send()` is bound to the validated event and captured signal/transport. It
 * never opens another connection; publishEvent returns its original receipt.
 * The secret is borrowed: its lifetime and zeroing remain broker-owned.
 */
export function createLocalSigningDelegate(secret) {
  return {
    async signEvent(template, signal) {
      signal?.throwIfAborted();
      return finalizeEvent(template, secret);
    },
    // NIP-OA authorizes an agent using a raw digest, not a Nostr event.
    async authorizeAgent(pubkey, signal) {
      signal?.throwIfAborted();
      const digest = createHash("sha256")
        .update(`nostr:agent-auth:${pubkey}:`)
        .digest();
      return Buffer.from(schnorr.sign(digest, secret)).toString("hex");
    },
    async publishEvent(_event, send, signal) {
      signal?.throwIfAborted();
      return send();
    },
  };
}
