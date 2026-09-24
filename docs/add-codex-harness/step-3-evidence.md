# Step 3 checkpoint — 2026-09-24

Base commit: `13d81047df1607099fe831d88085513b53b42972`; evidence below applies
to the local step-3 changes on `pazar/add-codex-agent-harness`.

Phil selected **@agentclientprotocol/codex-acp 1.3.0** as the adapter baseline.
The original Buzz installation remains read-only. No package, ordinary account,
Codex configuration, identity, relay agent, or runtime pin was changed.

## Real isolated compatibility boundary

The installed package manifest and ACP `initialize.agentInfo` both report
`@agentclientprotocol/codex-acp` 1.3.0. Standalone CLI reports `codex-cli 0.151.0`.
The installed adapter source uses `CODEX_PATH` when supplied; otherwise it selects
its bundled `@openai/codex` dependency. The alignment follow-up leaves `CODEX_PATH` unset by default, matching original
Buzz. Version/login probes now invoke `codex-acp cli`; an explicit absolute
override still selects the same executable for both checks and execution.

Ran `spike.py` with the installed absolute adapter path, first with the adapter's
bundled default, then with `BUZZ_SPIKE_CODEX_PATH=/opt/homebrew/bin/codex` to bind
the standalone CLI. Both passed:

- ACP v1 initialization; adapter auth method IDs `api-key` and `chat-gpt`.
- Disposable logged-out HOME/CODEX_HOME rejects session creation.
- Pinned Buzz ACP rejects that same logged-out session.
- An isolated custom provider at closed loopback permits session configuration:
  model selection and the selected model's advertised effort are acknowledged.
- Pinned `buzz-acp models` still omits thought-level metadata, preserving the
  reason for the narrow native discovery helper.

No prompt, login ceremony or paid inference was sent. This proves the isolated
protocol/configuration boundary, not normal account reuse or a managed relay reply.
The spike's restricted PATH includes Homebrew Node; production managed-Node/GUI
resolution has separate acceptance below.

## Implementation and regression boundary

- Draft/saved discovery and launch share the resolver. Launch now resolves it
  once; ambient allowed environment values are captured once per context.
- Adapter and CLI executable/interpreter checks are non-spawning and bounded.
  npm `env node` shims resolve through the same restricted directories used at
  execution. Explicit paths with spaces remain literal; no shell parsing.
- Native saved draft resolution merges write-only patches with revision checks
  and does not persist the draft or expose stored values to the frontend.
- CLI version/login probes have bounded output/deadlines and reuse containment.
  Only explicit logout text is authoritative. Raw diagnostics are discarded.
- Discovery checks exact adapter identity/version/protocol before session creation.
  Start's existing lifecycle is unchanged; launch-time authentication and applied
  settings/fallback reporting remain step 6 work.

Focused production-path tests cover missing tools/interpreters, CLI override,
malformed versions, saved patch preservation/removal/CAS, native creation, distinct
login failures, output bounds, timeout cleanup, and existing cancellation and
model/effort behavior. Synthetic credential strings do not enter returned errors.

## Remaining acceptance

Step 3 is **not fully accepted** until GUI-launched detection and the real desktop
context are verified. Also deferred: attended normal-login reuse, real reply,
project/profile precedence, browser/API-key fallback, applied-setting evidence,
packaged builds and other-platform checks. No new platform support is implied;
Windows discovery retains actionable unavailability. The step-0 fallback-reporting
choice is still open. No GUI app or existing agent was restarted for this checkpoint.

## Checks on this working tree

- `bin/cargo test -p buzz-agent-controller --lib`: 43 passed, 1 existing staged-runtime test ignored.
- `bin/cargo test -p buzz-foundation agent_models --lib`: 29 passed, 1 existing staged-runtime inference test ignored.
- `bin/cargo clippy -p buzz-agent-controller -p buzz-foundation --lib -- -D warnings`: passed.
- `bin/cargo fmt --all` and `git diff --check`: clean.
- Both isolated installed-adapter spike runs described above passed.

The ignored opt-in runtime tests, full native app/browser suites, hosted CI,
GUI/real-account journeys and platform/package checks were not run. No frontend
source changed. Native changes require restarting the development app before
manual verification; refresh Codex models after restart to replace cached evidence.

## Native startup failure found during attended testing

The user could create Codex-test-3, but mentions reported “Agent listener exited”.
The deployed `target/debug/agent-runtime/buzz-acp` reproduced immediate SIGKILL
before logging, while the source resource executable passed the lifecycle check.
macOS kernel logs reported `load code signature error 2` and a policy rejection
for the deployed path at the user's failed-start times. Both files had identical
SHA-256 values and passed on-disk `codesign --verify`; those checks alone did not
prove launchability.

Tauri's resource staging uses an in-place `fs::copy`. The macOS build now
atomically republishes staged runtime files on fresh inodes after that copy,
preserving executable permissions, signed bytes and the integrity manifest.
No signature check is disabled and no credentials are changed. The native app
was rebuilt and the deployed executable then reached its CLI parser instead of
being killed. The existing staged-runtime lifecycle test now targets the deployed
profile directory rather than source resources, so it exercises this boundary.

A real channel reply remains to be confirmed after retrying Start/mention.

Startup-repair validation: native app build, resource inode regression, and native
Clippy passed. The deployed-copy start/restart/stop/quit test initially encountered
an integrity mismatch while resource builds overlapped. After builds settled, all
five deployed/source manifest hashes matched and the unchanged lifecycle test
passed (8.14 seconds). This does not claim that starting an agent during resource
replacement is supported; existing integrity checks correctly reject a torn copy.

## Alignment validation

The installed adapter's real `cli -V` reports **codex-cli 0.147.0** (its bundled
engine); standalone CLI remains 0.151.0. `cli --version` is intercepted by the
adapter and reports its own 1.3.0 version, so production uses `-V`. A disposable
HOME/CODEX_HOME returned the expected `Not logged in` from `cli login status`.
No account credentials or inference were used.

Controller coverage exercises a real child -> bounded diagnostics capture ->
controller snapshot, with raw secret-like output excluded. Existing creation IPC
coverage now uses the bundled CLI entry point. These checks do not establish that
Codex-test-3 can publish an authenticated channel reply.

Validation after alignment: 46 controller tests and 15 Codex tests passed;
native library clippy and the native app build passed. The deployed ACP listener
start/restart/stop/quit test passed after resource staging finished (8.24 s).
Its first attempt overlapped a native build and reproduced the integrity failure;
this confirms the remaining build/launch race, not a resolved packaging contract.

## Duplicate replies after native reload

The September 24 live screenshot showed three distinct replies to one mention.
Process inspection found five orphaned Codex-test-3 listeners plus its current
listener. Native dev reload can bypass the Tauri Exit callbacks and Rust Drop;
the desktop-held ownership lock is released while detached listener sessions
remain alive. Original Buzz has an orphan sweep; this controller had omitted it.

On macOS, Start now sweeps orphaned listeners for the exact bundled executable
before spawning a replacement, under the existing identity lock. It checks parent
PID 1 and rechecks executable/start-time identity before session teardown; live
owners and other executable paths are excluded. Failed or incomplete cleanup
blocks replacement. It reuses the existing bounded session teardown, including
workers in separate process groups. No keys or environment dumps are needed by
the recovery path. This is restart recovery, not immediate parent-death cleanup;
a listener can survive an abrupt exit until the next start. Linux orphan recovery
and dead-leader receipt tracking are not added by this macOS fix.

Regression coverage abruptly exits a real subprocess owner, invokes production
orphan cleanup, and verifies both removal of the abandoned listener and survival
of a listener whose owner is still alive. A fresh public-channel mention is still
needed to confirm one visible reply in the live app.
