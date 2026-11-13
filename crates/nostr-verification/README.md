# Native Nostr signature verification

The desktop's `relay_verify_signatures` command calls this crate on its existing
blocking worker. The input and result remain one signature claim and one boolean
per event, in order. JavaScript still validates each event and recomputes its
NIP-01 content hash before sending a claim; this crate cannot establish that an
event ID matches an event body.

## Batch selection and correctness

Chunks contain at most 512 claims. A chunk uses cryptographic batch verification
when it contains at least 12 claims and no more than one distinct author per
eight claims. Otherwise it retains individual libsecp256k1 checks. These are
performance thresholds, not security assumptions: both paths must reject invalid
claims. The threshold comes from local Apple Silicon measurements and should be
remeasured on other supported architectures before claiming a speedup there.

The batch equation accumulation is adapted from Zcash Foundation FROST's
`frost-core/src/batch.rs`; [NOTICE.md](../../NOTICE.md) pins the source and license.
Signature preparation is separate from weighted equation accumulation, as in
FROST. The local adaptation combines repeated-author terms and uses
[BIP-340's batch verification coefficients](https://github.com/bitcoin/bips/blob/master/bip-0340.mediawiki#batch-verification)
instead of an external random source. It adds no FROST dependency.
It hashes every public key, message (the 32-byte event ID), and signature into a
ChaCha20 seed. The first coefficient is one; later coefficients are sampled by
rejection from the nonzero scalars below the curve order. This binds the weights
to the entire batch, including its signatures. Fixed weights would let crafted
invalid signatures cancel each other's errors.

RustCrypto `k256` 0.14.0 performs point/scalar decoding and the variable-time
multi-scalar multiplication. Each nonce point and public key is lifted to the
unique even-Y curve point, and each signature scalar must be below the group
order. Terms for the same public key are combined. All arithmetic inputs are
public; no signing or secret-key operation uses this path. This small batching
layer and k256's newer variable-time multiplication are not claimed to be covered
by k256's historical audit.

A successful batch accepts its signatures with BIP-340's negligible probability
of accepting an invalid batch. If decoding or the batch equation fails, every
claim in that chunk is checked individually with libsecp256k1. This preserves
valid neighbors and the existing rejection behavior. There is no recursive retry,
new queue, timer, or persistent key/proof cache. Invalid batches cost more work
than the original loop; the chunk cap bounds each fallback's work and scratch
space, not the size of the existing IPC request.

## Correctness checks

From the repository root, with Hermit activated:

```sh
cargo test -p buzz-nostr-verification --locked
```

Tests cover the official 15 BIP-340 vectors with 32-byte messages, native-verifier
equivalence with seeded mutations and permutations, mixed authors and vector
batches, every invalid position in a batch, malformed input,
duplicates, chunk boundaries, and cancelling signature errors. The Tauri command
test exercises both a successful batch and failed-batch fallback through the real
async command. Existing frontend tests own event-body hashing, proof-cache
validation, and delivery ordering.

The CSV fixture is the upstream `bitcoin/bips` file
`bip-0340/test-vectors.csv`, retrieved November 11, 2026, under its CC0-1.0 option.
Upstream SHA-256: `34c9d1d9c3a88d524bc80778540dc43f8306ec249a7485293063c376db851c2d`.
The vendored copy normalizes line endings to LF.
Its four variable-message-length vectors are rejected by the Nostr-only API.
