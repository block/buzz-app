# Buzz Agent Open AI API-key setup

Scope agreed September 25, 2026: implement OpenAI API-key setup directly in
buzz-app for **Buzz Agent**. Updated September 28 to mirror Buzz's environment
settings storage, as requested. Attended setup reached model discovery and agent
creation; successful inference remains blocked by the test account's credits.

## Implementation checkpoint

The pinned Buzz Agent revision `84b0fd04b7831657df2873c3a835412f47cebb03` already
accepts `OPENAI_COMPAT_API_KEY`, `BUZZ_AGENT_PROVIDER=openai`, an explicit
`BUZZ_AGENT_MODEL`, and the official OpenAI endpoint. No runtime pin changed.
The setup uses [OpenAI's models list](https://developers.openai.com/api/reference/resources/models/methods/list).
That response supplies IDs and basic metadata, not reasoning-effort choices or
proof of conversation/tool compatibility. The picker displays returned IDs and
requires an explicit model; effort is **Runtime default**, not **Not supported**.

**Check key and load models** validates the submitted key without persisting it.
On success the form stages `OPENAI_COMPAT_API_KEY` in the agent's environment
draft. Save/Create writes it with the model in the existing atomic agent store
(`agent-controller/agents.json`). This is plaintext local storage with owner-only
permissions on Unix, matching the original Buzz environment-settings approach.
Cancelling the form writes nothing; a failed revision-checked Save preserves the
previous settings. Saved keys remain write-only in snapshots and are resolved
natively for Refresh. The provider setup has no macOS Keychain dependency.
Existing identity storage and Unix process containment still limit overall app
platform support; this change does not certify Windows execution.

Discovery uses the existing ticket/cancellation lane, disables redirects and
proxies, has a 20-second HTTP deadline, and caps responses at 2 MiB and 10,000
models. Conflicting saved/draft provider, model, effort, endpoint, or proxy
overrides are rejected natively before key use. Creation repeats native catalog
validation before generating an agent identity. Discovery is not paid inference.

Creation resolves device-wide defaults through the same native path as discovery.
The pending creation binds the submitted draft and its effective settings; changed
drafts or defaults require a new preflight before credential persistence. Unchanged
retries reuse the prepared identity. Only submitted values are persisted, so
inherited settings remain inherited.

Launch reads the provider key from saved environment settings and passes it
through the child environment, never arguments. Managed setup sends the explicit
model and omits effort overrides. Legacy/manual configurations retain their
existing launch behavior until explicitly configured through this flow.
Identity acquisition keeps its existing Start ticket and revision fences.
Save does not restart a running worker.

The shared create/edit form offers this only for bundled Buzz Agent with Open AI
and native setup capability. Key input is local to the form and cleared on
submission, context change, or closure; saved key values are never returned to the
frontend. Checked keys remain in the unsaved environment draft until Save/Cancel.
Provider changes retire outstanding requests, and late success cannot select a
key in a different draft. Selecting an imported agent's existing model
explicitly establishes the new runtime-default policy.

Leaving managed Open AI clears the model/configuration and stages deletion of its
agent-specific key. Saving applies that deletion; cancelling preserves the saved
agent. An OpenAI key inherited from OpenAI Agent defaults is scoped to the effective
OpenAI provider, including legacy environment provider overrides. Explicit legacy
and custom per-agent environments retain their existing behavior.

Focused coverage includes production IPC against synthetic HTTP, environment
persistence, model-list rejection/empty/malformed/oversized responses,
timeouts and cancellation, saved-context conflicts, native creation validation,
actual child launch, Save/Restart/reopen, and mounted form races and key clearing.
Successful inference, desktop layout, signed packages and other platforms require
separate attended acceptance.

Historical validation on the September 25 Keychain implementation (superseded;
these counts do not validate the September 28 environment-storage change):

- `cargo test -p buzz-agent-controller --lib`: 50 passed; three existing opt-in
  fixture/runtime tests ignored by the default run.
- `cargo test -p buzz-foundation --lib`: 68 passed; two existing staged-resource
  tests ignored by the default run.
- The staged-resource `native_start_restore_disconnect_stop_and_quit_fence_late_credentials`
  test passed separately with `--ignored`, covering both identity and OpenAI waits.
- 69 Vitest cases passed across Open AI setup, harness/model controls,
  create/edit, draft conversion, model-service and native-adapter files.
- TypeScript and Clippy for the controller/native library passed. Independent
  review findings for imported same-model selection and preflight error recovery
  were addressed. No live provider request or credential was used for these checks.

September 28 attended check: the saved OpenAI agent selected `gpt-5.6-sol` and
had its key in environment settings. `/v1/models` succeeded and listed that model;
a minimal `/v1/responses` request returned HTTP 429 with
`credit_balance_exhausted`. A successful reply has not been demonstrated.
The separate runtime-error commit projects that code into a sanitized no-credits
diagnostic and an editor alert. Automated tests use synthetic keys only.

September 28 commit checks for the environment implementation:

- Controller library: 51 passed, three existing opt-in/fixture tests ignored.
- Native library: 68 passed, two staged-resource tests ignored.
- Focused frontend suite: 70 passed across eight files; TypeScript passed.
- Controller/native library Clippy passed with warnings denied.
- The real-child Save/Restart/reopen regression passed again after adding a
  legacy endpoint/model/imported-effort compatibility assertion.
- Independent review identified the legacy launch guard issue; the scoped guard
  and regression preserve the original execution behavior.

These checks do not establish Windows support, signed-package behavior, or a
successful account-backed reply after replenishing credits. No live credentials
or response payloads are committed.

## User flow

1. In the existing shared create/edit form, choose **Buzz Agent** and
   **Provider: Open AI**.
2. Show a masked **Open AI API Key** input and an explicit submission action.
   An existing saved environment key can be reused without returning its value.
3. Submit through the native host to authenticate a bounded model-list request.
   Clear the entered key on submission completion or form closure. Show actionable
   authentication, network, empty-catalog, and agent-save errors.
4. Choose a model from the returned catalog. Show only metadata actually supplied
   by the provider or verified in the bundled runtime; do not invent reasoning
   choices, model compatibility, or inference entitlement.
5. Save/create explicitly. Reopen and app relaunch preserve the provider, model,
   and environment key without repopulating the key field.
6. Start, or explicitly restart an existing agent, to apply saved settings.
   The Buzz Agent worker uses the same selected credential and model. Saving
   does not change an already running worker.

## Required implementation

- Add Open AI to Buzz Agent's native provider metadata. Render setup according
  to the selected harness/provider, using existing form and design-system owners.
- Reuse the ticketed model-operation lane and cancellation contracts. Keep API
  keys out of catalog/cache identities, diagnostics, logs, snapshots, and returned
  errors. No provider request runs merely because the Agents page opens.
- Persist the key in the existing agent environment settings, as requested,
  with the same atomic Save/Create and local file protections. Do not reuse
  Codex/Goose account credentials or introduce a separate provider secret store.
- Define replacement and failed-save behavior before coding persistence: a failed
  save must preserve the previous working association; a cancelled draft must
  not silently change another agent's account. Reuse existing atomic revision-
  checked Save/Create rather than introducing independent UI writes.
- Bind discovery and execution to the same effective provider, key, endpoint,
  and model. Resolve saved write-only overrides natively; conflicts must be
  actionable rather than validating one context and launching another.
- Use official OpenAI for this flow. Custom OpenAI-compatible endpoints are
  outside this slice. Validate endpoint/override handling before passing a key
  to a request or process.
- Verify the pinned Buzz Agent's OpenAI inputs and model requirements. Preserve
  Default/Advanced semantics; if OpenAI needs an explicit model and has no runtime
  default, expose that requirement rather than silently selecting a model.
  Do not turn absent effort metadata into a claim of unsupported effort.
- Require native validation for creation; UI success is not authority. Preserve
  usable drafts, explicit retry, and Stop recovery after failures.

Likely owners are `src/bundled/agents/AgentHarnessEditor.tsx`,
`AgentModelPicker.tsx` and `AgentSettingsFields.tsx`; shared contracts under
`src/features/agents`; the native `agent_models` owner and provider catalog;
and controller credential/configuration/runtime code. Add a provider-specific
native module if needed, without a general provider framework. Inspect the
immutable runtime dependency before deciding whether any runtime change is needed.
The original `block/buzz` checkout remains reference-only.

Before source edits, record the concrete files, environment persistence design,
model/effort contract, and production diff estimate after inspecting those owners.
If a bundled-runtime change is necessary, identify it explicitly before expanding
this buzz-app slice.

## Acceptance and checks

- Buzz Agent with Open AI shows the key setup; Codex and Goose do not acquire it.
  The existing Databricks flow continues to work.
- Synthetic-key tests exercise the production native command path: accepted and
  rejected keys, network failure, empty/malformed/oversized catalogs, timeout,
  cancellation, and late completion after a provider switch.
- Verify the key persists only in the intended environment settings, not IPC
  results, shared model-cache keys, or diagnostics. Failed Save preserves recovery.
- Test native launch configuration using synthetic values, plus save/reopen and
  replacement behavior. The tested launch must consume the credential used for
  discovery, including after an app restart.
- Mounted form tests cover masking, clearing, accessible labels, keyboard use,
  provider switching, stale validation, and failed-save draft preservation.
- After the safety checks, perform an attended native journey with a real key:
  model lookup, explicit selection, create/save, start, and one real Buzz reply.
  Restart/reopen confirms persistence. Automated model lookup does not certify
  inference; no paid inference or live credentials enter unattended tests.
- Record checked versions and deferred native/platform checks. Follow the normal
  focused iteration and batch-validation workflow; do not run `just scan` as a
  routine handoff gate.

## Excluded

Codex browser login or API-key authentication; Goose credential setup; additional
providers; custom endpoints; automatic provider/model selection; a general secret
manager or provider registry; new reasoning controls without verified metadata;
changes to the user's standalone Codex/Goose configuration; unrelated listener,
resource-staging, or reply fixes.

## Relationship to PR #214

[PR #214](https://github.com/block/buzz-app/pull/214) merged September 24. At head
`5c98864cad158ecd72640bc610541bc546d096bc` it adds Goose provider choices including
OpenAI, reuses credentials configured via `goose configure`, and discovers only
Databricks v2 models. It does not add in-app OpenAI key submission, OpenAI model
discovery, or the OpenAI choice for Buzz Agent. Its Goose controls are existing
adjacent work, not this implementation's acceptance evidence.
