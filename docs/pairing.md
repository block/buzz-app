# Pair mobile

`buzz.pairing` is an enabled-by-default bundled Settings plugin. Settings →
Plugins can disable it independently. The plugin contributes `mobile` through
`ctx.settingsCards.register` in the Account group, using the existing Settings
shell, navigation and contribution lifecycle. It reads the existing
`communityReader` capability without acquiring another relay session.

The plugin owns its React UI and the short-lived IPC client. The native host
uses the app's existing IdentityHost for account access, NIP-11 pairing-route discovery,
ephemeral NIP-42 authentication, encrypted NIP-AB exchange, QR generation, and
session cancellation. No account private key crosses IPC. Plugins are trusted
in-process code, as elsewhere in this app; this is an ownership boundary, not a
new plugin security sandbox. The frontend CSP is unchanged.

## Behavior

1. With an active account, the selected community prefills the address. Without
   a live app account, **Use existing Buzz account** reads only the public identity
   from the current app identity. The user supplies a community address.
2. Opening Pair mobile automatically verifies the public identity against the
   saved native account, opens a dedicated pairing socket, and waits for subscription
   readiness before showing the QR. Each attempt expires after two minutes and
   automatically renews while the section remains open. Connection failures show
   **Try again** instead of retrying indefinitely.
3. A compatible phone advertises encrypted `desktop-code-v1` support. Desktop
   generates a separate random six-digit code that is never sent in the QR or
   challenge. The phone submits the entered code; desktop verifies it with a
   five-attempt budget before sending the encrypted account payload.
4. Older phones retain explicit **Codes match** confirmation. Desktop never uses
   that action to bypass a code-entry phone's proof.
5. **Phone paired** requires the phone's successful import acknowledgement.
   If a sent transfer times out awaiting acknowledgement, **Check your phone**
   preserves the uncertain outcome and requires a deliberate new attempt.
   Closing or reloading the window, leaving the Settings section, switching accounts/communities, disabling the
   plugin disposes the attempt. Retries use a fresh native session.

Pairing uses the current native app identity through a purpose-bound
`IdentityHost.with_key` operation. The public viewer is checked before producing
the encrypted transfer payload. It never reads or mutates the original Buzz
credential store. Browsers explain that pairing requires desktop. The mobile
implementation remains in `block/buzz`.

Only secure community origins and secure advertised pairing URLs are accepted.
Redirects are disabled for discovery, setup traffic is bounded, and both early
offers and late authentication challenges are handled. Cancellation prevents
subsequent work; it cannot retract a payload already delivered to the phone.

## Verification

- `crates/pairing`: imported protocol tests and vectors from PR #8085, pinned to
  `ac0ad7c3004683e5db813492846d787404a2b475`; see its README for provenance.
- Native tests: account mismatch, code-entry and legacy transfers, phone import
  failure, stale-session cancellation, secure destination validation, and actual
  local WebSocket subscription/authentication exchanges with temporary keys.
- Frontend tests: late start/status cancellation, replacement ordering, cleanup
  failure, and legacy-only desktop confirmation. App composition verifies real
  plugin enable/disable and registration lifetime.
- Browser journeys: real Settings navigation and plugin UI with fixture IPC in
  Chromium and WebKit. These do not prove a live phone handoff or OS Keychain UI.

Run focused pairing, Settings lifecycle and native identity checks, including
`bin/cargo test -p buzz-pairing` and native pairing tests.
Hosted CI runs `cargo test --workspace`, which includes the pairing crate.
