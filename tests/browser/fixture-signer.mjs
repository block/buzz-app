import { schnorr } from "@noble/curves/secp256k1.js";
import { getEventHash, getPublicKey, verifiedSymbol } from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";

// Each app fixture owns its signer and immutable ephemeral keys. Prepare their
// public keys once, while still signing and verifying every event with Noble.
export function createFixtureSigner() {
  const publicKeys = new WeakMap();
  return (event, key) => {
    let pubkey = publicKeys.get(key);
    if (!pubkey) {
      pubkey = getPublicKey(key);
      publicKeys.set(key, pubkey);
    }
    event.pubkey = pubkey;
    event.id = getEventHash(event);
    event.sig = bytesToHex(schnorr.sign(hexToBytes(event.id), key));
    // schnorr.sign self-verifies, as in nostr-tools' finalizeEvent. This marker
    // stays in Node; serialized events are independently verified by the app.
    event[verifiedSymbol] = true;
    return event;
  };
}
