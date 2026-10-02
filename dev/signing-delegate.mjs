import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { finalizeEvent, getPublicKey } from "nostr-tools";

/** Local event-signing delegate. The secret is borrowed and broker-owned. */
export function createLocalSigningDelegate(secret) {
  return {
    async getPublicKey() {
      return getPublicKey(secret);
    },
    async signEvent(template, signal) {
      signal?.throwIfAborted();
      return finalizeEvent(template, secret);
    },
  };
}

/** Local-only raw Schnorr capabilities; these are not Nostr event signing. */
export function createLocalSigningCapabilities(secret) {
  return {
    // NIP-OA authorizes an agent using a raw digest, not a Nostr event.
    async authorizeAgent(pubkey, signal) {
      signal?.throwIfAborted();
      const digest = createHash("sha256")
        .update(`nostr:agent-auth:${pubkey}:`)
        .digest();
      return Buffer.from(schnorr.sign(digest, secret)).toString("hex");
    },
    async signHarnessLogProof(id, pubkey, relay, nonce, signal) {
      signal?.throwIfAborted();
      const digest = createHash("sha256")
        .update(`buzz-app:harness-log:v1:${id}:${pubkey}:${relay}:${nonce}`)
        .digest();
      return Buffer.from(schnorr.sign(digest, secret)).toString("hex");
    },
    async authorizeAgentCommunity(pubkey, relay, signal) {
      signal?.throwIfAborted();
      const digest = createHash("sha256")
        .update(`nostr:agent-community:${pubkey}:${relay}`)
        .digest();
      return Buffer.from(schnorr.sign(digest, secret)).toString("hex");
    },
  };
}
