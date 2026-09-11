# Local agent controller — implementation checkpoint

This crate is a **not-yet-integrated draft**, not a runnable replacement for old Buzz.
It owns native configuration/import and listener process lifetime without Tauri,
React, or the old desktop manager. The `Controller` must be called by one serialized
native host owner; dropping a page is not dropping this controller.

Implemented with isolated filesystem/credential/subprocess fixtures:

- Bounded, versioned, profile-locked settings with atomic replacement, previous
  revision backup, stale-save refusal, immutable exact agent/community IDs.
- Explicit chosen-source import preview; source drift and malformed config refusal;
  linked prompt/model/provider, runtime and environment resolution; native-only
  opaque preservation; disabled import and create-only verified credential custody.
- Write-only environment patch semantics and explicit public DTO projection.
- Idempotent start, save-versus-running revision, explicit restart, durable disabled
  Stop, enabled restore, exit/failure state, and teardown of separate process groups
  inside the listener's isolated Unix session.
- Native attestation verification before spawn (unrestricted NIP-OA only); no parent
  managed-agent identity/replay/marker/provider credential inheritance.

## Known incomplete boundaries — do not claim live readiness

- No Tauri commands/host loop or production OS credential adapter is attached yet.
- Runtime tools must come from this app's own independently packaged bundle; no
  artifact download/build/pinning pipeline or packaged launch has been verified.
- Cross-app/cross-profile exact-key exclusion is **not implemented**. The profile
  file lock only excludes another controller using that same profile. Old Buzz
  does not honor it. No live imports/starts should be exposed before this is closed.
- The Unix-session cleanup handles ACP's ordinary new process groups. A descendant
  that explicitly starts another session can escape this containment. Host crash
  recovery and such detached tools require further ownership work. Windows is not
  supported by this process adapter. The fixture uses macOS `/usr/bin/python3`.
- Status is process-alive, **not relay readiness, accepted mention, working or idle**.
  Worker wake and idle sleep are configured on ACP; no live ACP test has run here.
- Owner-less legacy agents, conditional attestations, teams, remote deployment,
  relay mesh and unrecognized legacy catalog harnesses fail closed. Custom harness
  definitions can be imported but provider mappings outside buzz-agent/goose require
  explicit environment configuration. Compiled-in legacy provider defaults cannot
  be recovered from JSON. Existing instance runtime wins over linked runtime,
  matching `readiness.rs`'s actual `try_record_agent_command` call (old `b9392d9`).
- Import currently snapshots definitions per exact keyed instance, not editable
  shared definition relationships. Unknown fields are retained, not all executed.
- Environment overrides are stored in mode-0600 local config, not in the OS
  credential store. Secret agent keys never intentionally enter that config.
- Default MCP/provider behavior, ACP argument normalization, execution policy and
  workspace preservation need a real compatibility acceptance pass.
- Child stdout/stderr are discarded; user diagnostics are fixed host messages.
  A safe live readiness/diagnostic adapter is still needed.

Tests are engineering evidence only. Test-only keys are public secp256k1 vectors;
no live credential storage, current agent restart, old-library mutation, relay
publication or enrollment is performed. Do not run this against real data yet.
