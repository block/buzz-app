import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE, hexToBytes } from "@noble/curves/utils.js";
import {
  getEventHash,
  verifiedSymbol,
  type Event,
  type VerifiedEvent,
} from "nostr-tools";

type Point = ReturnType<typeof schnorr.utils.lift_x>;
const { Point, utils } = schnorr;
const { Fp, Fn } = Point;
// A recent author's BIP-340 key, lifted once. Authors repeat across a channel's
// history, so after a few valid signatures the key also gets a window-4 wNAF
// table: about one verification of work, which a narrow window repays within a
// few later signatures even in channels of many occasional authors. The table
// lives as long as the point; the bound caps the tables at a few MB.
const AUTHORS = 32;
const TABLE_AFTER = 3;
const authors = new Map<string, { point: Point; uses: number }>();

function author(pubkey: string) {
  let entry = authors.get(pubkey);
  if (entry) authors.delete(pubkey);
  else {
    // Throws for x ≥ p or x not on the curve, as schnorr.verify's lift_x does.
    entry = {
      point: utils.lift_x(bytesToNumberBE(hexToBytes(pubkey))),
      uses: 0,
    };
    const [oldest] = authors.keys();
    if (authors.size >= AUTHORS && oldest) authors.delete(oldest);
  }
  authors.set(pubkey, entry);
  return entry;
}

/** BIP-340 verification, step for step as @noble/curves' schnorr.verify, but
 * with the author's point reused from `author`. */
function verifySchnorr(sig: Uint8Array, message: Uint8Array, pubkey: string) {
  const entry = author(pubkey);
  const P = entry.point;
  const r = bytesToNumberBE(sig.subarray(0, 32));
  if (!Fp.isValidNot0(r)) return false;
  const s = bytesToNumberBE(sig.subarray(32, 64));
  if (!Fn.isValidNot0(s)) return false;
  // bytes(P) is the pubkey's own 32 bytes: lift_x accepted x < p and kept even y.
  const e = Fn.create(
    bytesToNumberBE(
      utils.taggedHash(
        "BIP0340/challenge",
        Fn.toBytes(r),
        hexToBytes(pubkey),
        message,
      ),
    ),
  );
  const R = Point.BASE.multiplyUnsafe(s).add(P.multiplyUnsafe(Fn.neg(e)));
  const { x, y } = R.toAffine();
  const valid = !R.is0() && y % 2n === 0n && x === r;
  // Only valid signatures earn a table; forged ones cannot force builds.
  if (valid && ++entry.uses === TABLE_AFTER) P.precompute(4);
  return valid;
}

/** Same contract as nostr-tools' verifyEvent for a freshly owned event. */
export function verifyEvent(event: Event): event is VerifiedEvent {
  let valid = false;
  try {
    valid =
      event.sig.length === 128 &&
      event.pubkey.length === 64 &&
      getEventHash(event) === event.id &&
      verifySchnorr(hexToBytes(event.sig), hexToBytes(event.id), event.pubkey);
  } catch {
    valid = false;
  }
  event[verifiedSymbol] = valid;
  return valid;
}
