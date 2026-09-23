# Add the Codex agent harness

Status: Steps 1 and 2 are implemented; Codex is now selectable with shared
launch/discovery context, a separate login-status probe, adapter-advertised model
choices, model-dependent effort, and native creation validation. The approved
trust boundary accepts ACP-advertised choices without claiming fresh remote
account entitlement. Live account, rendered desktop and inference acceptance
remain outstanding; steps 0 and 3–7 are not declared fully accepted.
Written 2026-09-23 for branch `pazar/add-codex-agent-harness`.

## Follow-up fixes — September 23

- [x] Hide the Provider input when Codex is selected, including an absolute
  `codex-acp` executable path.
- [x] Cache Codex discovery in the app control service (up to 16 contexts,
  memory only) and refresh headlessly when the selected Codex editor/context
  opens without a cached catalog. Cached model/effort choices can satisfy the UI
  gate; native creation always revalidates the submitted selection. Explicit
  refresh replaces cached evidence. Requests abort on context change/unmount;
  no login opens.
- [x] Remove the empty Codex Advanced → Model disclosure. Explicit model and
  model-specific effort remain under Configuration → Advanced; Environment
  stays available.
- [x] Display the initial ACP session's model and effort in Default mode, before
  any explicit model selection. Missing metadata is shown as not reported;
  cached values are labeled. Defaults are never copied into saved overrides.

Validation on this working tree: TypeScript passed; 50 tests passed across
`models.test.ts`, `AgentHarnessEditor.test.tsx`, `AgentModelPicker.test.tsx`,
`AgentCreateDialog.test.tsx`, and `AgentsPage.test.tsx`. All eight native
`agent_models::codex::tests` passed, including initial defaults before explicit
selection. Rust formatting and `cargo clippy -p buzz-foundation --lib -- -D warnings`
passed. Regression coverage includes StrictMode, cached reopening, stale context
responses, failed-refresh validation, and bounded cache disposal.

Rendered native desktop, browser layout, real-account default/inference acceptance,
and other-platform checks remain outstanding; these fixes are not completion of
the broader integration ledger below. Restart the native development app to load
the new defaults response before trying the Default display.

## Model catalog parity with original Buzz

- [x] Prefer the original Buzz managed `node-tools/bin/codex-acp` and its
  pinned Node runtime before system installations; preserve explicit adapter paths.
  Both discovery and launch use this resolver.
- [x] Match original `normalize_agent_models`: read every model-category
  `configOptions` entry, append `models.availableModels`, retain order, and
  deduplicate IDs with the stable entry winning. Stable labels use `displayName`;
  legacy labels use `name`, with model IDs as the fallback.
- [x] Validate legacy `model[effort]` choices against the base model's advertised
  effort options and the adapter's `session/set_model` response. Missing effort
  evidence remains unknown and cannot enable Advanced creation.

Local installation evidence: original Buzz resolves managed
`@agentclientprotocol/codex-acp` 1.3.0; the previous buzz-app search resolved
Homebrew `@zed-industries/codex-acp` 0.16.0. No installed packages were modified.
Catalog parity depends on using the same adapter and account/configuration context;
custom executable or environment overrides can intentionally change the catalog.
Validation: all 10 `agent_models::codex::tests` and both controller tests selected
by `cargo test -p buzz-agent-controller codex --lib` passed. Workspace Rust
formatting and Clippy for the controller and native app passed. Tests bind the
production parser, resolver and ACP transport. Live desktop comparison remains
deferred; restart the native app and refresh models to use the managed adapter.

## Complete model/effort cache and separate controls

This follow-up supersedes literal legacy-variant picker parity above.

- [x] Load all base-model effort choices in one bounded ACP session, once per
  execution context. Each base model is selected at most once during discovery.
- [x] Cache the complete catalog in memory, independently of the selected model
  or configuration mode. Reopening and model changes reuse it; explicit Refresh
  reloads it. Context/revision changes use separate cache entries.
- [x] Display each configurable base model once. Omit `model[effort]` aliases
  when that base is advertised; effort belongs in the separate Effort field.
- [x] Preserve older saved aliases for native validation, display their base
  model, and normalize to separate fields on an explicit model/effort edit.
- [x] Keep native Create validation fresh and selection-specific. A cached UI
  choice never bypasses the native authentication/model/effort checks. Refresh
  failure invalidates cache reuse and retains an explicit retry affordance.

Validation: 49 tests across the model service, picker, creation dialog and Agents
page passed; 11 native Codex tests passed. Native call-count assertions verify
one session and one effort probe per base model; UI tests verify model/mode
changes and reopening use the cached catalog, and stale effort cannot validate
another model. TypeScript, Rust formatting and native Clippy passed. Live desktop timing/layout remains unverified; restart the
native app to use the updated discovery response.

## Outcome and boundaries

Users can select Codex when creating or editing an agent, reuse their existing
Codex installation and authentication, choose runtime defaults or an explicit
model, configure supported reasoning effort, and run the agent through Buzz ACP.
Browser sign-in and API-key entry are recovery/setup paths when authentication
is missing, not a mandatory new login ceremony.

All edits belong in **buzz-app on the current feature branch**. The original
`/Users/pazar/Development/buzz` checkout is reference-only. Do not edit its source,
installed agent library, credentials, or configuration. Do not create new branches,
worktrees, commits, or PRs merely because this document proposes PR boundaries.

The UI work primarily belongs in `src/bundled/agents`. Native changes are required:
a dropdown alone cannot establish authentication, discovery, or execution.

Out of scope: additional harness integrations, remote execution, a harness plugin
marketplace, a universal form-schema language, per-agent account management,
automatic edits to the user's Codex config, and live mid-conversation model/effort
switching. Installation recovery is in scope; a general multi-harness installer
framework and a general provider registry are not. Provider-aware harness metadata
and the Open AI setup flow described below are in scope. Other advanced settings
are included only when the adapter contract and application path are verified;
arbitrary raw options are not a substitute for functioning controls.

Follow [AGENTS.md](../../AGENTS.md), [contributing](../contributing.md), and the
existing [agent control contract](../agent-control.md). Before implementation,
publish a short scope checkpoint and inspect affected files for `FOUNDATION`
markers; those edits require explicit human guidance under the repository rules.

## Agreed behavior

1. **Reuse existing authentication first.** Resolve `codex` and a compatible
   `codex-acp`; check `codex login status` in the effective execution context.
   A missing adapter is distinct from a missing login. Timeout, spawn failure,
   and invalid configuration are not authoritative logged-out results.
2. **Default and Advanced are distinct configuration modes.** Default delegates
   model and effort to the selected harness, normally `~/.codex/config.toml` or
   the effective `$CODEX_HOME/config.toml` for Codex. Let Codex resolve its full
   configuration, including supported project/profile precedence; do not claim
   the home file is its only source of defaults. Advanced requires explicit
   handling and validation of model and effort before Create. An unselected
   placeholder does not satisfy either field. Agent editing never rewrites the
   runtime config. No ChatGPT web/mobile preference synchronization is implemented.
3. **Use one context everywhere.** Readiness, authentication, discovery, and launch
   must agree on executable/adapter, arguments, workspace where relevant,
   environment, and credential/configuration location. Resolve saved write-only
   environment values natively; never return them to the browser. Preserve the
   launcher's environment isolation rather than inheriting all ambient variables.
4. **Authentication is separate from agent identity.** Multiple agents may share
   the user's Codex account with the standalone CLI. Explain that fallback login
   can change this shared account. Do not port Databricks's app-cache Disconnect
   action into a button that silently logs out the user's standalone Codex.
5. **Save does not restart.** Persist one revision-checked snapshot. Existing work
   continues with its running revision; explicit restart applies saved changes to
   new sessions. Connect does not save or start an agent.
6. **Capabilities drive controls.** Obtain model IDs and supported effort values
   from actual adapter evidence. Query the selected model's configuration before
   displaying model-dependent options. Do not hardcode a current OpenAI model list.
7. **Report what is known.** Installed, authenticated, ACP-session-capable, process
   running, and successful inference are different facts. A saved model is not
   proof of the applied model. Preserve errors and retry affordances.
8. **Stay lazy as the catalog grows.** Opening Agents must not spawn every harness,
   probe every account, or start authentication. Selecting/setup of a harness can
   trigger bounded headless checks; browser opening and credential writes require
   the corresponding explicit user action. Refresh is headless.
9. **Make provider requirements explicit.** Harness catalog entries that require a
   provider, including Buzz Agent, carry a Provider tag/capability in their native
   metadata. Selecting one of those harnesses displays a Provider field; selecting
   **Open AI** displays a masked Open AI API Key field. After the user submits the
   key, use it through the native secret boundary to list that account's available
   models and model metadata. Do not hardcode the model list, expose the key to the
   browser after submission, or infer provider requirements from harness labels.

### Step 1 decisions — Default and Advanced

The following product direction supersedes independent per-field Runtime default
choices in Advanced. The shared contracts and Databricks flow implement these
requirements; Codex session discovery and effort selection remain in steps 3–7.

- **Default:** omit both Buzz overrides and delegate configuration to the selected
  harness. Do not copy the resolved defaults into the saved agent as explicit
  selections. Switching back to Default must remove overrides; legacy imported
  values must not silently reappear.
- **Advanced:** block creation while authentication or either field remains
  pending, unknown or invalid. Validate authentication in the effective execution
  context, validate the model ID using the adapter's discovery/selection evidence,
  then validate effort against the options returned for that selected model.
  Changing the model invalidates the previous effort-validation evidence.
- **Model names:** display the adapter's name alongside its stable ID. Names are
  labels, not independent configuration keys or evidence of access. Unknown IDs
  must show an actionable model error; do not silently substitute another model.
- **Effort:** no hardcoded universal choices. "High" may be an unselected hint
  only if the selected model advertises that value. A hint never counts as a
  choice, and values returned for another model cannot validate the current one.
- **Discovery:** separate static integration capabilities from live session
  options. Missing metadata is unknown; it is not proof of an empty catalog or
  unsupported effort. Session discovery and accepted settings do not certify
  inference, quota or permanent account entitlement.
- **Errors:** return distinct, sanitized authentication, model and effort
  failures. Keep missing executables, invalid configuration, timeouts and network
  failures distinguishable from a definitive logged-out or invalid-selection
  result. Preserve the draft and expose explicit recovery/retry.
- **Creation authority:** the future UI gate must be backed by native validation
  before creating an identity or persisting the agent. Browser-supplied booleans
  cannot authorize creation. Validation must apply to the submitted draft and
  execution context; stale or cancelled results cannot enable Create. This gate
  does not resolve the separate launch-time fallback/reporting decision in Step 0.

Implementation choices for this slice: defaults belong to the selected harness;
there is no Buzz-owned web/mobile default or ChatGPT preference synchronization.
A confirmed lack of an exposed effort control is handled explicitly as **Not
supported**. Databricks currently supplies that evidence; missing metadata never
does. The UI gates new configuration modes on native `configurationAvailable`.

Step 1 owns the DTOs and their Databricks caller. Native Databricks preflight now
runs headlessly before identity generation, and commit binds the exact validated
draft. Codex authentication, session options and its validation branch are now wired;
live acceptance and additional setup recovery in steps 3–7 remain. Save still does not restart or certify applied settings.

## Source map and current gaps

All links below point to buzz-app. Proposed new filenames are labeled as such.
The migration reference is
`/Users/pazar/Development/buzz/docs/codex-harness-migration-handoff.md`; consult its
source map for the old implementation, but do not copy its full settings system.

| Owner | Current code | Required change |
| --- | --- | --- |
| Create/edit forms | [AgentCreateDialog](../../src/bundled/agents/AgentCreateDialog.tsx), [AgentEditor](../../src/bundled/agents/AgentEditor.tsx), [AgentSettingsFields](../../src/bundled/agents/AgentSettingsFields.tsx) | Share Codex setup, model, and effort controls; retain Save/Restart semantics |
| Harness and model UI | [AgentHarnessEditor](../../src/bundled/agents/AgentHarnessEditor.tsx), [AgentModelPicker](../../src/bundled/agents/AgentModelPicker.tsx) | Capability-based rendering; remove Databricks assumptions from common UI |
| Draft conversion | [agent-edit](../../src/bundled/agents/agent-edit.ts) | Round-trip optional Codex settings and effort without persisting credentials |
| Frontend host contract | [control](../../src/features/agents/control.ts), [models](../../src/features/agents/models.ts), [control-native](../../src/features/agents/control-native.ts) | Typed harness-specific inputs/results behind shared operations; preserve ticket cancellation |
| Native catalog and host | [agents](../../src-tauri/src/agents.rs), [command registration](../../src-tauri/src/lib.rs) | Catalog metadata, setup operations, native command wiring |
| Connection/discovery owner | [agent_models](../../src-tauri/src/agent_models.rs) | Extract Databricks-specific work; add bounded Codex operations without holding the controller lock across waits |
| Settings and storage | [config](../../crates/agent-controller/src/config.rs), [store](../../crates/agent-controller/src/store.rs), [import](../../crates/agent-controller/src/import.rs) | Backward-compatible fields, validation, preservation of imported settings |
| Launch and lifecycle | [runtime](../../crates/agent-controller/src/runtime.rs), [process](../../crates/agent-controller/src/process.rs), [bundle](../../crates/agent-controller/src/bundle.rs) | Shared effective context, adapter resolution, selected model/effort, process cleanup |
| Runtime packaging | [runtime pin](../../runtime/agent-runtime.json), [build script](../../scripts/build-agent-runtime.mjs), [native dependencies](../../src-tauri/Cargo.toml) | Change only if compatibility verification proves it necessary |
| Product documentation | [agent-control](../agent-control.md), [agents](../agents.md) | Document new behavior, shared credentials, defaults, support limits, and evidence |

Current findings from source inspection:

- Buzz ACP is already bundled at revision
  `84b0fd04b7831657df2873c3a835412f47cebb03`; do not port a second relay harness.
- The native harness catalog offers Buzz Agent/Databricks. Model requests and the
  native model context currently assume Databricks.
- Agent settings live in native `agents.json`, not a new database to introduce.
- External harnesses currently need an absolute executable. Launch uses
  `env_clear()` and a restricted PATH, so an npm adapter's Node interpreter needs
  explicit resolution; merely finding `codex-acp` is insufficient.
- The pinned ACP engine supports `BUZZ_ACP_MODEL` and `BUZZ_ACP_EFFORT_LEVEL`.
  The controller currently forwards imported `effort_level`, but has no editable
  effort field. Explicitly resolve new-field versus legacy-import precedence.
- The pinned `buzz-acp models` command filters discovery output to model options.
  It does not expose full reasoning capabilities. Do not build an effort picker
  under the assumption this command already supplies those values.
- Existing ACP can continue on an adapter-default model after selection failure.
  The controller discards stdout/stderr; user-visible application/fallback evidence
  needs a concrete, bounded path rather than an assertion based on stored settings.
- Local process containment is Unix-oriented; native create/import credentials
  are currently macOS-only. This feature must not imply new cross-platform support.

## Architecture and PR split

Use a small native harness catalog, runtime-specific integrations, and shared
capability-driven UI. Separate installation, authentication, and session
capabilities. Share the operation envelope, cancellation, error handling, and
configuration resolution; retain specialized authentication implementations.
ACP integrations should reuse protocol handling where practical. Do not implement
a speculative provider registry or copy the old desktop's lifecycle owners.

Proposed PRs, in dependency order:

| PR | Steps | Mergeable result |
| --- | --- | --- |
| 1. Extract shared harness contracts | 0–2 | Existing Databricks flow uses the boundaries with no behavior regression; Codex not offered yet |
| 2. Add native Codex integration | 3–6 | Tested setup/auth/discovery/persistence/launch through native APIs; public chooser still withheld |
| 3. Enable Codex create/edit/setup | 7–9 | Complete user flow, local acceptance, documentation, and regression coverage |

Prototype enough of Codex in step 0 to inform PR 1. A scaffold with no current
caller is not acceptable: Databricks must exercise the shared contracts. These
are review boundaries, not permission to expose incomplete UI. Combine PRs 2/3
if separating them creates unused infrastructure or duplicates integration work.

Rough initial production-diff review budgets (excluding tests/docs/generated lock
changes): PR 1, 200–400 changed lines; PR 2, 800–1,400; PR 3, 300–600. These are
scope alarms, not quotas. Reassess after the protocol spike, especially if a new
installer, protocol helper, or runtime diagnostics channel is needed. Explain the
smallest complete alternative before materially expanding scope; never delete
coverage or compress code to fit a budget.

## Step-by-step implementation checklist

### Step 0 — Verify the adapter and close implementation decisions

- [ ] Inspect/test an exact supported `codex-acp` version with the pinned Buzz ACP.
- [ ] Verify CLI login reuse, browser/API-key fallback, effective `CODEX_HOME`,
  project configuration, session creation, model switching, and effort options
  after switching. Record versions and redacted results, not credential contents.
- [x] Choose the smallest full-capability discovery mechanism inside buzz-app.
  Prefer a usable existing API; otherwise add a narrowly scoped, bounded native
  ACP discovery helper. Do not edit vendored caches or the original buzz checkout.
- [x] Decide install recovery: detected/manual absolute executable support plus
  actionable instructions, or an explicit app-managed install/update action.
  If automatic installation is selected, define package/version/prefix ownership,
  Node resolution, cancellation and interruption recovery before writing it.
- [ ] Establish how actual model/effort application and fallback reach the user.
  Preserve the old fallback only with truthful reporting; if the existing engine
  cannot expose sufficient evidence, bring back a concrete alternative (such as
  fail-closed explicit selection) before changing the agreed behavior.

**Code:** inspect the runtime pin, native model owner, controller runtime, and
the pinned ACP dependency source. Any spike/helper code belongs in buzz-app;
update this document with the chosen mechanism before expanding implementation.

**Acceptance:** supported versions, auth mechanism, configuration precedence,
installation recovery, full-capability discovery, and applied-setting evidence
have concrete implementation paths. No fabricated model/effort catalog and no
assumption that a standalone CLI upgrade upgrades the adapter's bundled runtime.

**Testing:** protocol/subprocess fixture plus an actual installed-adapter handshake.
Use a temporary workspace/context for mutations. Real account tests use the
operator's explicit authentication interaction. A handshake is not inference.

### Step 1 — Extract harness-aware native and frontend contracts

- [x] Give native catalog entries stable harness identity and capabilities,
  distinct from resolved executable paths. Preserve custom absolute commands and
  existing records; do not classify arbitrary executables by display label.
- [ ] Add an explicit Provider tag/capability to catalog entries that require
  provider configuration. Buzz Agent must opt into this capability; harnesses
  without it must not render provider controls.
- [x] Separate shared operation/status envelopes from Databricks-specific
  host/filter inputs. Use typed variants for runtime-specific settings.
- [x] Define optional model/effort overrides, discovery metadata, and safe errors.
  Keep static setup capabilities distinct from live session options. Represent
  Default versus Advanced intent and the separate authentication/model/effort
  outcomes described above; do not treat a placeholder as a validated selection.

**Code:** `src/features/agents/{control,models,control-native}.ts`, native
`agents.rs`/`agent_models.rs`, and controller DTOs where necessary. Small new
`harnesses` modules are proposed only if they clarify ownership.

**Acceptance:** the shared operation contracts have a Databricks caller;
harness-specific optional capabilities do not require Databricks to implement
Codex reasoning effort. Old saved records/custom values remain usable. Native metadata remains the UI authority.
No passive auth, probes, or process startup is introduced by snapshots/rendering.

**Testing:** extend `control-native.test.ts`, `models.test.ts`, native
`agent_models/tests.rs`, and native command tests. Test safe rejection of invalid
request variants and compatibility behavior for missing host capabilities.

### Step 2 — Route existing Databricks through the shared boundaries

- [x] Move Databricks auth/catalog details behind their owning integration.
- [x] Keep the existing ticket admission, cancellation, teardown, and stale-result
  fences. Do not add a second background polling or retry system.
- [x] Let common UI consume capabilities while preserving Databricks defaults,
  custom model entry, OAuth isolation, override warnings, and Disconnect recovery.

**Code:** `agent_models.rs`, `models.ts`, `AgentHarnessEditor.tsx`,
`AgentModelPicker.tsx`, `AgentSettingsFields.tsx`, existing test fixtures.

**Acceptance:** Databricks create/edit/connect/refresh/disconnect works as before;
Save does not restart, empty/error results preserve model entry, and pending model
work does not block Stop. PR 1 adds no selectable but unusable Codex entry.

**Testing:** run existing model/control/form suites and affected native tests.
Test cancellation before/after ticket allocation and context changes during a
pending request. Locally confirm an existing Databricks agent still replies.

### Step 3 — Resolve Codex execution context and readiness

- [ ] Add Codex metadata and resolve CLI, adapter, version, and required interpreter.
- [ ] Build one native effective-context resolver for draft/saved discovery and
  launch. Merge saved write-only patches natively with revision checks.
- [ ] Preserve normal HOME/CODEX_HOME semantics without inheriting unrelated
  provider secrets. Honor configured context consistently, including GUI startup.
- [ ] Add bounded, sanitized availability/auth checks and explicit retry/setup.
  Implement the installation recovery selected in step 0.

**Code:** proposed `crates/agent-controller/src/harnesses/` Codex/context modules,
`runtime.rs`, native setup owner near `agent_models.rs`, catalog in `agents.rs`.
Touch packaging/build files only when step 0 establishes the need.

**Acceptance:** default and overridden credential/configuration contexts agree
across operations; missing CLI, missing adapter, outdated adapter, invalid config,
unknown probe result, and logged-out state remain distinguishable. A relative
catalog identifier resolves safely without weakening custom-command validation.

**Testing:** fake executables through the production resolver/probe; minimal PATH,
spaces in paths, npm shebang/interpreter resolution, missing/malformed versions,
timeouts, oversized output, and cleanup. Confirm a GUI-launched app detects the
real installation. Unsupported platforms produce actionable unavailability.

### Step 4 — Reuse login and implement explicit authentication fallbacks

- [ ] Check existing login before offering a login ceremony.
- [ ] Add browser sign-in and masked API-key submission through verified native
  mechanisms. Pass keys via protected input such as stdin, never shell arguments,
  persisted agent settings, diagnostics, snapshots, or model-cache keys.
- [ ] Recheck login after completion. Authentication action completion alone is
  not readiness. Clear entered key state when finished/closed.
- [ ] Keep refresh headless; cancel child processes and retire stale results.
  Explain shared credential impact; do not add implicit global logout.

**Code:** proposed native Codex auth module, `control-native.ts`, typed operation
contracts, and command registration. UI wiring follows in step 7.

**Acceptance:** already-authenticated users proceed without browser/API-key entry;
both fallback paths can recover a logged-out context. Cancellation never claims
rollback of credentials already written. Secrets stay out of saved agent JSON
and returned diagnostics. No unconfirmed login success is shown as ready.

**Testing:** production command path with fake login processes for success,
rejection, timeout, cancel, invalid config, and late success. Inspect synthetic-key
fixtures for leakage. Exercise browser and API-key login in separate temporary
Codex contexts without logging out the normal account; no live secrets in tests.

### Step 5 — Discover models and model-dependent configuration

- [ ] Implement the full-capability discovery path chosen in step 0.
- [ ] Initialize/create a session in the effective context; select an explicit
  draft model before collecting its supported reasoning choices.
- [ ] Normalize model IDs, defaults/current values, supported effort options,
  and capability absence without claiming entitlement or successful inference.
- [ ] Bound protocol messages, output, duration, and child lifetime. Fence stale
  results by context/request generation and keep explicit refresh available.
- [ ] Invalidate cached evidence on app-driven login/context/adapter changes;
  external account/config changes are refreshed explicitly, not magically known.

**Code:** native Codex discovery helper, shared model DTOs and `models.ts`;
`AgentModelPicker` consumes the result in step 7. Do not assume `buzz-acp models`
exposes reasoning options or that its ACP client module is a public reusable API.

**Acceptance:** changing models yields the new model's supported choices and
invalidates previous effort validation; Default mode remains selectable.
Failure and authoritative empty results are distinct.
Discovery never saves, launches the managed relay listener, or performs paid
inference. Saved selections are not erased by asynchronous catalog mismatch.

**Testing:** fake ACP executable speaking the actual protocol through the native
helper. Cover stable/legacy model metadata where supported, grouped options,
missing effort, changed effort after model switch, malformed/oversized responses,
unsupported saved IDs, timeout, cancellation and child cleanup. Compare one real
adapter's results with its session metadata.

### Step 6 — Persist settings and bind them to execution

- [ ] Add backward-compatible optional Codex/effort settings and round-trip DTOs.
  Define legacy imported effort precedence, including explicit clearing back to
  runtime default; a hidden imported value must not resurrect a cleared override.
- [ ] Reuse effective context for launch. Apply model and effort through the
  supported ACP startup path after model selection, retaining literal arguments.
- [ ] Preserve atomic Save, expectedRevision, saved/running revision distinction,
  Stop recovery, native credential ownership, and process containment.
- [ ] Implement the bounded actual-setting/fallback evidence selected in step 0.
  Sanitize it; do not expose full session transcripts or raw process logs.

**Code:** controller `config.rs`, `store.rs`, `import.rs`, `runtime.rs`,
`agent-edit.ts`, shared control DTOs, and narrowly scoped native diagnostics wiring.

**Acceptance:** unset model/effort emits no override and respects runtime defaults;
explicit values reach the session. Reopen/relaunch preserves settings. Save alone
does not alter current work. Unsupported/rejected selections cannot be displayed
as successfully applied; missing auth blocks actionable startup rather than false
readiness. Imported and custom-agent behavior remains supported as documented.

**Testing:** store compatibility/CAS/failure tests, import tests, and runtime tests
capturing actual child configuration with synthetic values. Test defaults,
explicit/cleared effort, shared versus alternate CODEX_HOME, saved overrides,
model fallback, stop/restart/quit, and launch failures. Observe real session
model/effort before claiming live acceptance; model self-description is not proof.

### Step 7 — Enable shared Codex setup/create/edit controls

- [ ] Expose Codex only when the complete native integration is wired.
- [ ] For Buzz Agent and any other provider-tagged harness, render Provider with
  an **Open AI** option. Selecting it reveals a masked Open AI API Key input;
  submitting the key loads the user's models and model metadata for selection.
- [ ] Render installed/login state, setup recovery, browser/API-key fallback,
  model picker, Default/Advanced modes, and supported effort controls.
- [ ] Block Advanced creation until current-context authentication, model and
  effort handling validate. Show separate actionable errors. Enforce the gate
  natively before identity creation/persistence as well as in the UI.
- [ ] Keep setup accessible from both create and edit; no separate divergent form.
- [ ] Define harness-switch behavior explicitly: retain per-harness drafts or
  visibly reset incompatible fields on the user's action. Never let hidden
  Databricks provider values block Codex or silently delete write-only overrides.
- [ ] Preserve unsaved drafts and recovery controls on failures, stale revisions,
  unavailable capabilities, and rejected selections. Explain restart requirements.

**Code:** `AgentHarnessEditor.tsx`, `AgentModelPicker.tsx`,
`AgentSettingsFields.tsx`, `AgentCreateDialog.tsx`, `AgentEditor.tsx`, `agent-edit.ts`.
Proposed cohesive `AgentHarnessSetup`/`AgentReasoningFields` components are optional;
reuse design-system primitives rather than creating new shared UI infrastructure.

**Acceptance:** create and edit support the same Codex flow; Databricks-specific
fields do not appear for Codex. Saved values survive discovery failure. Every
interactive element has a single accessible label and keyboard operation. Older
native hosts/browser-only mode show truthful unavailability, not dead actions.

**Testing:** colocated RTL tests with real React/StrictMode and deferred promises.
Cover pending/unmount/context-switch races, key field clearing, model-dependent
effort, Default/Advanced selection, dirty/stale edits, save failure, and harness
switching. Prove a placeholder, missing/invalid model, invalid effort, failed auth,
and stale validation cannot enable Advanced creation or bypass native enforcement.
Extend `agent-edit.test.ts`, `AgentHarnessEditor.test.tsx`,
`AgentModelPicker.test.tsx`, and `AgentsPage.test.tsx` as appropriate.

### Step 8 — Verify app composition, accessibility, and lazy operation

- [ ] Extend representative whole-app fixtures through the real injected host
  contract. Keep failure matrices in native/RTL tests.
- [ ] Verify focus, keyboard navigation, disclosure/layout, and recovery in both
  Chromium and WebKit for affected browser journeys.
- [ ] Test a catalog with dozens of synthetic harness entries: opening Agents
  triggers no per-harness process/network work; selected-harness requests coalesce
  or cancel correctly. Record a cold/warm local opening check.

**Code:** `src/features/agents/control-testing.ts`,
`tests/fixtures/agent-control.*`, and affected
`tests/browser/{agent-control,agent-models,agent-editor-grid}.spec.mjs`.

**Acceptance:** UI/native contract is wired through actual app composition; adding
catalog entries does not multiply startup work. No hidden dialogs or stale
responses open login or overwrite a new harness's controls.

**Testing:** representative browser journeys for composition and browser-specific
focus/layout only; native invocation counters for lazy behavior. Use deterministic
gates, not sleeps/retries. Record added browser cases and their unique justification.

### Step 9 — Run live desktop acceptance and close documentation

- [ ] Run the journey below with the existing local development setup.
- [ ] Update `docs/agent-control.md` and relevant agent docs with final behavior,
  defaults, credential sharing, install path, fallback policy, and platform limits.
- [ ] Record exact code/runtime/adapter versions, automated checks, live outcomes,
  and remaining gaps. Separate ready-to-try from validated.
- [ ] Review the combined feature diff, not only individual PRs; finish applicable
  native checks and normal repository CI before declaring integration readiness.

**Code:** documentation and only fixes owned by the feature discovered during
acceptance. Unrelated refactors/failures are follow-up work.

**Acceptance:** a real Codex agent replies in Buzz using observed default settings,
then observed explicit model/effort after edit/restart; settings survive app
relaunch. Databricks still works. Auth fallback flows have their own live evidence.
Deferred packaged/other-platform checks are named, not implied by local success.

**Testing:** native Tauri application and real relay/adapter, plus the focused
regressions affected by any fixes. Synthetic CI cannot certify account access,
provider policy, real inference, or OS credential behavior.

## Local acceptance runbook

Use the user's existing `.env.local` launch configuration; do not print, commit,
replace, or copy its contents. From the current buzz-app checkout:

```sh
bin/just desktop
```

The existing desktop recipe prepares runtime resources. A web-only server is
useful for UI fixtures but cannot prove native process/authentication behavior.
Complete auth, persistence, and protocol safety checks before exercising real
accounts or saved agents. Use a dedicated test agent/channel/workspace and a short
non-destructive prompt. Do not modify the user's ordinary Codex config to force
an edge case.

| Check | Action | Required evidence |
| --- | --- | --- |
| Existing installation/login | Choose Codex with the user's normal context | CLI/adapter recognized; authenticated status; no new login UI |
| Defaults | Leave model and effort at Runtime default; create/start/mention | Real reply plus safe actual-session evidence matching effective runtime configuration |
| Explicit overrides | Save another supported model/effort | Saved revision changes; running revision/work remains unchanged |
| Apply changes | Restart and send a new prompt | New session applies the selected model and effort; real reply |
| Return to defaults | Clear overrides, save/restart | No retained legacy/model/effort override; runtime configuration wins |
| Durability | Quit/relaunch the app | Saved configuration retained; enabled/start behavior matches the existing contract |
| Browser fallback | Use a temporary logged-out CODEX_HOME and explicitly sign in | Verified login, discovered models, successful reply; normal account untouched |
| API-key fallback | Use another temporary context and enter a key through the form | Verified auth and successful reply; no key in agent JSON, snapshots, logs, or fixture artifacts |
| Recovery | Missing adapter or failed discovery in an isolated fixture/context | Actionable repair/retry; draft/defaults preserved; no misleading ready state |
| Existing harness | Create/edit/start a Databricks agent | Existing connection, model selection and reply still work |

Creating temporary authentication contexts must use the same production context
resolution, not a test-only alternate launcher. Cancel does not promise to undo
completed authentication. Retire temporary test processes before cleaning up
their contexts; do not delete shared/global credentials. Never commit raw session
traffic, account identifiers, credentials, or unredacted logs as evidence.

## Validation commands and cadence

Use pinned tools. Select affected tests rather than running the entire repository
for every UI iteration. Representative commands (add new files as implemented):

```sh
bin/pnpm exec vitest run src/features/agents/models.test.ts src/features/agents/control-native.test.ts src/bundled/agents/agent-edit.test.ts src/bundled/agents/AgentHarnessEditor.test.tsx src/bundled/agents/AgentModelPicker.test.tsx
bin/pnpm typecheck
bin/cargo test -p buzz-agent-controller
bin/cargo test -p buzz-foundation
bin/pnpm test:browser tests/browser/agent-control.spec.mjs tests/browser/agent-models.spec.mjs tests/browser/agent-editor-grid.spec.mjs
```

Confirm the selected browser run covers both engines; native tests that require
resources need the documented runtime preparation first. Run affected full test
files after fixes, including relevant cancellation/recovery cases. Final native
changes require formatting/Clippy/build checks as applicable and existing CI;
native/dependency changes also need the repository's appropriate platform checks.
Do not routinely run `just scan`: follow the interactive iteration/batch gates
in contributing. Documentation-only work needs content/link/diff checks, not builds.

Every PR records: checked commit, test commands/results, live evidence, deferred
checks, and behavior changes. Do not mark a checkbox complete on mock evidence
when its acceptance explicitly requires a live boundary. No live-account login or
paid inference is part of unattended CI.

## Completion ledger

- [ ] Step 0 decisions recorded and supported adapter version established.
- [ ] PR 1 contracts exercised by unchanged Databricks behavior.
- [ ] PR 2 native Codex integration verified, including process cleanup and secrets.
- [ ] PR 3 complete create/edit/setup UI enabled and browser acceptance complete.
- [ ] Existing Codex login and runtime defaults verified locally.
- [ ] Browser and API-key fallback journeys verified in isolated contexts.
- [ ] Actual selected model/effort verified after restart; fallback reporting verified.
- [ ] Databricks regression journey complete.
- [ ] Documentation and final validation evidence current with the checked code.
- [ ] Remaining packaging/platform limitations explicitly recorded.
