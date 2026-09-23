# Steps 0–2 implementation checkpoint — 2026-09-23

All changes are in buzz-app on `pazar/add-codex-agent-harness`. No installation,
credential, original Buzz source, runtime pin or live agent was changed.

## Verified adapter boundary

Installed npm package: `@zed-industries/codex-acp` **0.16.0**; ACP `agentInfo`
independently reports the same version. Standalone CLI: **0.151.0**. Adapter
`--version` is rejected, so that flag cannot be the version probe. The npm shim
uses `/usr/bin/env node` and delegates to a platform binary.

The adapter's [versioned manifest](https://github.com/zed-industries/codex-acp/blob/v0.16.0/Cargo.toml)
pins its embedded Codex libraries to **rust-v0.137.0**. Upgrading the standalone
CLI does not upgrade them. This is a candidate compatibility baseline, not a
completed supported-version certification.

Run the committed, no-login/no-inference spike:

```sh
/usr/bin/python3 docs/add-codex-harness/spike.py /absolute/path/to/codex-acp
```

The spike uses disposable HOME/CODEX_HOME/cwd, an explicit PATH, bounded output
and deadlines, and process-group cleanup. It never reads the ordinary account.
Observed results:

- Installed adapter accepts ACP v1 initialization.
- Auth method IDs: `chatgpt`, `codex-api-key`, `openai-api-key`.
- `session/new` in the isolated logged-out context returns authentication required.
- The staged Buzz ACP at `84b0fd04b7831657df2873c3a835412f47cebb03` also rejects
  that unauthenticated session.
- In a temporary context using a custom provider pointed at closed loopback, the
  installed adapter creates a session, accepts a model ID selected from its own
  returned options, and accepts a returned effort value after that model switch.
  No prompt is sent. The observed `thought_level` config ID is `reasoning_effort`;
  never assume the category itself is the config ID. This also exercises the
  effective CODEX_HOME config file, but does not prove real account entitlement.
- A synthetic subprocess speaking actual ACP returns model and `thought_level`
  options. Pinned `buzz-acp models --json` retains only the model option. This
  verifies the discovery limitation against the binary, not just a source search.

## Decisions for the next implementation slice

**Installation:** detect existing installations and support explicit absolute
executables, with manual installation/update instructions. No app-managed npm
installer in this feature. Resolve Node for the npm shim in the same restricted
launch context; do not broaden ambient environment inheritance.

**Discovery:** implement a narrowly scoped native ACP helper in buzz-app. The
pinned ACP crate's `acp` module is private, and its models command cannot return
full effort capabilities. Helper sequence: initialize, session/new, select an
explicit model, read the returned config options. Bound message/total output,
duration and process-tree lifetime; use the existing ticket lane. A model/effort
list comes only from the returned session evidence.

The adapter's [request handler](https://github.com/zed-industries/codex-acp/blob/v0.16.0/src/codex_agent.rs)
implements `session/set_config_option` and returns refreshed configuration after
selection. Its session builder adjusts cwd from the startup configuration;
therefore launch the probe in the actual workspace before initialization rather
than assuming session/new alone reloads project settings. Project/profile precedence and real-account model-dependent effort still need
acceptance testing.

**Authentication:** use standalone CLI login status first in the exact execution
context; do not invoke advertised authentication methods on refresh. Browser
login and stdin API-key login remain explicit recovery actions. Recheck status
and ACP session creation afterward. The isolated handshake does not verify
reuse of a real login or compatibility of CLI 0.151.0 credentials with the
adapter's older embedded runtime. Those checks require attended authentication.

**Defaults and effort:** the initial extraction left the Step 1 override,
discovery-metadata and safe-error contract incomplete. Deferring its definition
entirely to steps 3–6 did not meet the Step 1 checklist. The subsequent product
decision introduces Default mode (delegate to the harness) and Advanced mode
(explicit, validated model/effort handling before creation). See the updated
[Step 1 decisions](README.md#step-1-decisions--default-and-advanced) and remaining
scope questions. DTOs and contract tests belong in Step 1; execution resolution,
persistence and native creation enforcement follow in steps 3–7. Databricks must
exercise shared contracts, but must not invent a reasoning-effort capability.

## Open gate: actual applied-setting evidence

Inspection of the immutable dependency shows that session model rejection can
continue with the default. `pool.rs` emits `control_result` and session config
through its observer. The CLI exposes only `run()` publicly; its observer module
is private. Current controller launch disables relay observer publication and
discards stdout/stderr. Capturing stderr cannot establish successful application.

The available existing route is the encrypted relay observer, which carries more
than model metadata and would need owner-authorized decryption, bounded scoped
subscription, and run/session correlation in buzz-app. This is a separate shared
subsystem expansion, not part of the contracts-only slice. A smaller local
alternative requires an upstream runtime release exposing a bounded structured
settings channel. Fail-closed selection would change the agreed fallback
behavior and also requires runtime support. **Do not claim step 0 complete or
implement either expansion silently.** Resolve this gate before exposing Codex.

## Implemented contracts and validation

The physical production diff exceeds the initial 200–400-line alarm primarily
because existing native Databricks code and advanced UI controls moved into
dedicated files. At that checkpoint the ticket lifecycle, runtime pin and persisted schema were
unchanged; no new lifecycle owner or retry system was introduced.

- Native catalog now supplies stable `id` and static `modelDiscovery` capability.
  Labels never classify executables; custom/absolute commands remain persisted
  as before. Existing native validation still owns provider/environment authority.
- Model requests have a tagged integration/settings variant; results separate
  integration-specific metadata from model entries and operation status.
- Databricks auth, defaults, filters and catalog transport live in
  `agent_models/databricks.rs`; its advanced controls have a dedicated component.
  The original shared ticket admission/cancel/timeout/teardown lane is retained.
- Missing host metadata keeps manual model entry and issues no incompatible IPC.
  Databricks Disconnect remains available after changing to an unsupported harness.
- At that checkpoint no selectable Codex entry, new background probe, persistence change or restart
  behavior was added. No new browser test cases were added; the new cases bind
  native IPC and mounted React lifecycle directly.

Checks: TypeScript and formatting; 114 tests in seven focused control/model/form
Vitest files; 17 native model and agent command tests; the existing staged-runtime integration proving synthetic
OAuth → catalog → actual pinned worker inference → 401 refresh → restart; and
`spike.py` above. The synthetic worker reply is the verified end-to-end result,
not a real Databricks account or relay reply.

Remaining: attended Databricks reply, Codex login reuse/browser/API-key acceptance,
real-account model/effort switching, project/profile precedence, applied-setting
evidence decision, GUI installation detection, browser-engine and hosted CI checks.

## Default/Advanced implementation follow-up

The shared contract checkbox is now implemented. Optional explicit configuration
round-trips through native persistence, while records without it retain legacy
behavior. Default suppresses Buzz model and imported effort overrides; Advanced
uses the selected model/effort. Native metadata advertises support separately from
live discovery. Databricks returns authenticated catalog evidence with explicit
unsupported effort; the UI never infers that state from missing fields.

Creation has both a UI gate and headless native preflight before identity
creation. Commit refuses changed drafts. Tests exercise actual IPC for auth,
model-name-versus-ID and unsupported-effort rejection before an identity exists,
plus mounted form gating/recovery, persistence reopen, launch environment and
incomplete existing-agent discovery. No real credentials, account login or paid
inference were used. Codex remains unexposed and the Step 0 gates above remain.

Follow-up verification: 116 frontend tests across eight focused files; 38
controller and 40 native-host tests passed, with the 13 discovery/creation tests
rerun after the final native guard changes. Three staged-runtime tests remain
opt-in and were not repeated in this follow-up. TypeScript, Biome, Rust formatting
and diff checks passed. Independent review findings were fixed and covered by
regressions. GUI/browser-engine and real-account acceptance remain deferred.

## Direct setting-response probe

`response-spike.py` captures exact request/response envelopes in
[response-spike-evidence.json](response-spike-evidence.json). It ran against
codex-acp 0.16.0 with disposable HOME/CODEX_HOME/cwd and a custom provider at
closed loopback; no login or prompt was sent. The catalog is not account-access
evidence.

Observed via `session/set_config_option` (the stable method the pinned Buzz
runtime prefers for advertised model options):

- Advertised model selection returned `configOptions` with the selected model
  in `currentValue` and refreshed reasoning-effort options.
- Advertised effort selection returned `reasoning_effort.currentValue = low`.
- Invented effort returned JSON-RPC error -32602, `Invalid params`.
- Unknown config ID returned -32602 with `data: Unsupported config option`.
- Invented model ID was accepted and echoed as the current model, with no
  reasoning-effort option. Acceptance alone does not validate existence or
  inference access. The pinned Buzz resolver matches advertised IDs before
  issuing its startup model switch; this direct probe intentionally bypasses
  that guard.
- No interleaved notifications were observed during these exchanges.

This narrows the remaining evidence issue: the adapter supplies useful setting
responses; buzz-app still needs access to outcomes from the actual managed
session through the pinned runtime. A disposable setup session cannot certify
the configuration or inference success of a later managed session.
