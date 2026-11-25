# Native session DPoP: stages 1–2 (macOS client)

The macOS client can bind its organization session to a device key, as RFC 9449
(DPoP) describes. It is off unless the authority descriptor sets `dpop`. The
assertion lifetime and cached assertion reuse do not change. Relay enforcement
of the binding is a later stage, so this slice does not stop the use of a
stolen assertion together with the Nostr key at the relay.

## Client configuration

The native authority descriptor can set `dpop` to `secure-enclave` or
`software`. Only macOS implements a signer.

- `secure-enclave` checks the token attribute of the actual key, needs the
  platform facility, and has no software fallback. Verify a signed application
  with the necessary Keychain entitlements before you release this mode.
- `software` is an explicit weaker option. It does not resist a copied private
  key.

## What the issuer must accept

Every proof is a compact JWS with header `typ: dpop+jwt`, `alg: ES256` and a
public P-256 `jwk`. Its claims are `htm`, `htu`, `iat`, a random `jti`, and,
when a token is sent, `ath` = base64url(SHA-256(token)). The client makes `htu`
from the configured adapter base: HTTPS only, lowercase host, no default port,
no query or fragment. The issuer must compare it with the same public URL. The
client signs a new proof for every attempt, including retries.

1. **Login start.** The login URL carries `dpop_jkt`, the RFC 7638 SHA-256
   thumbprint (base64url, no padding) of the device key, together with the S256
   handoff challenge.
2. **Exchange.** `POST /v1/login/exchange` carries a `DPoP` proof from that key.
   The client accepts only a response with `token_type: "DPoP"`, a
   `session_token` and an `expires_at`. If the exchange response is lost, the
   user must sign in again. The client never falls back to a bearer exchange.
3. **Session requests.** Each request sends `Authorization: DPoP <token>` and a
   `DPoP` proof. A bound token is never sent as a bearer token or in `X-BB`.
4. **Human assertions.** The request also carries the exact-body NIP-98 event in
   `Nostr-Authorization`. The client signs it again for each attempt, with a
   random `nonce` tag.
5. **Agent enrollment.** The owner `subject_token` is the session token, and the
   proof's `ath` covers it. The agent's NIP-98 proof does not change.

Plugin forwarding with a bound session allows only `GET /v1/auth/me`, the Nostr
identity `current`, `challenge`, `verify` and `delete` operations, and backup
`status`. Other features that need a bearer session, such as hosted browser
integration, Decisions and device pairing, are not available with a bound
session.

## Errors the client handles

| Response | Client behavior |
| --- | --- |
| 401 `invalid_dpop_proof` | The proof was refused. The client keeps the session and does not send it as bearer. |
| 401 `fresh_authentication_required` | The user signs in again for that action. The session stays usable. |
| 401 `session_required` or `session_expired` | The session ended. The user must sign in again. |
| 400 `invalid_grant` | The owner session cannot enroll an agent. The user must sign in again. |
| 429, 503 | Temporary. The client retries later with new proofs. |

## Storage and lifecycle

- The storage slot is the same for bearer, software and Secure Enclave modes. A
  bound record is version 2. It stores the key handle and the key mode.
- Restore loads the same key. If the key is lost or the mode changed, the user
  must sign in again. The client never reads a bound token as a bearer token.
- A new sign-in replaces the record in the same slot and tries to revoke the
  replaced session. Sign-out removes the slot, so a mode rollback cannot restore
  an old session. Sign-out also clears a record that a newer build wrote.
- Before the client deletes a key, it checks that no current stored record uses
  it. Recovery uses its own key and a temporary session, and tries to sign that
  session out when it is done.
- Server revocation is best effort when the device is offline. If the process
  stops before it saves the record, or the OS cannot delete a key, an unused key
  can stay in the Keychain. There is no startup sweep, because it could delete a
  key that another copy of the app is using to sign in.

## Enablement precondition

Builds before this change read only version 1 records. They treat a version 2
record as corrupt storage, and the only way out is **Sign out of Buzz**, which
also removes the human key. Do not set `dpop` for a population while its users
can still run a build from before this change, on the same Mac.

## Verification limits

Not verified yet:

- a Secure Enclave key in a signed build;
- a combined run of native client, issuer and relay;
- behavior when the issuer refuses a bound login after a rollback.

The full native library test run has a known AppKit crash in a Tauri mock-window
test on macOS. It also occurs on the unchanged base.
