# Authenticated model discovery research — 2026-09-23

Scope: source/documentation research for installed codex-acp 0.16.0, which embeds
OpenAI Codex rust-v0.137.0. No user credentials were read, no login was started,
and no authenticated account request or inference was performed.

## Conclusion

Use authenticated discovery and a restricted model picker. However, this ACP
version's successful session/catalog response does not by itself prove that each
option came from a successful catalog request for the current account. It can
include cache, bundled presets, and an unknown currently configured model.

## Evidence

- [Official model/list documentation](https://learn.chatgpt.com/docs/app-server#list-models-modellist)
  directs clients to discover choices before rendering selectors and says models,
  efforts and defaults depend on client/account. This describes App Server,
  not an additional method exposed by the ACP adapter.
- [Adapter dependency pin](https://github.com/zed-industries/codex-acp/blob/v0.16.0/Cargo.toml)
  embeds Codex rust-v0.137.0 independently of the standalone CLI version.
- [Adapter thread code](https://github.com/zed-industries/codex-acp/blob/v0.16.0/src/thread.rs#L240)
  calls Codex ModelsManager with OnlineIfUncached. Its configuration builder
  (around lines 2972–3000) includes picker-visible presets, but also explicitly
  inserts the current model string when no matching preset exists. The response
  does not distinguish that synthetic choice from discovered model choices.
- [Codex model manager](https://github.com/openai/codex/blob/rust-v0.137.0/codex-rs/models-manager/src/manager.rs#L197)
  starts with bundled models and uses a five-minute disk cache. Refresh errors
  are logged and the current catalog is still returned (lines 229–235).
  Online refresh is gated by Codex-backend or command authentication (314–315).
- For ChatGPT login/token auth, a successful remote response containing at least
  one picker-visible model replaces the bundled catalog. Empty or hidden-only
  responses do not establish an authoritative empty picker: they can merge with
  bundled models. See the manager's apply_remote_models (323–352) and
  [tests](https://github.com/openai/codex/blob/rust-v0.137.0/codex-rs/models-manager/src/manager_tests.rs#L369).
- [Auth-mode filtering](https://github.com/openai/codex/blob/rust-v0.137.0/codex-rs/protocol/src/openai_models.rs)
  uses the catalog's supported_in_api flag outside Codex-backend mode. This is
  API compatibility metadata, not a per-key entitlement test. The manager tests
  also cover skipped refresh when external API-key auth overrides ChatGPT auth.
- [OpenAI API GET /models](https://developers.openai.com/api/reference/resources/models/methods/list)
  is the documented authenticated API model-list endpoint. It provides IDs and
  basic metadata, not Codex reasoning-effort metadata. It is distinct from the
  Codex model manager's richer catalog.

## Databricks comparison

The pinned Buzz Databricks implementation obtains a bearer token and queries the
workspace's v2 gateway/Unity Catalog model-service catalogs; buzz-app removes
upstream entries labeled as default catalog fallbacks. That is consistent with
the user's observation of account-visible choices. We did not test Databricks
ACL semantics here or equate catalog visibility with guaranteed inference success.

## Initial strict policy (superseded for Codex below)

1. Keep model IDs constrained to a catalog; names remain labels and effort choices
   come from the selected model's metadata. Do not hardcode either list.
2. For a strict current-account list, require successful authenticated remote
   discovery and preserve its provenance/failure state. Do not promote an ACP
   response's existence to proof that authentication or remote discovery succeeded.
3. ChatGPT mode needs a way to distinguish current-account remote results from
   fallback or cached results. The inspected ACP response lacks that evidence;
   an adapter/runtime extension or another supported source must supply it.
4. For standard OpenAI API-key mode, investigate intersecting the same key's
   GET /models IDs with Codex-compatible presets; keep effort metadata from Codex.
   This is a proposed implementation, not a tested integration. Custom providers
   require their own discovery policy and must not be queried at OpenAI by default.
5. Invalidate choices on account/provider/context changes and handle runtime
   rejections. Catalog membership cannot guarantee future quota or inference.

No harness integration code was changed by this research. Next live evidence is
an account-authorized model-list-only probe, comparing remote and ACP results,
including the refresh-failure path; no prompt is needed for that comparison.

## Initial shared refresh implementation checkpoint

The shared picker now exposes Refresh models outside Databricks settings. Advanced
Browse and Refresh use headless discovery; an authentication failure offers a
separate Connect account action. Legacy Browse retains its existing connect flow.
Refresh preserves the selected model/effort in the draft but invalidates creation
while pending, after failure, or when either selection disappears. Advanced accepts
only discovered model IDs and the selected model's advertised effort values; there
is no hardcoded High default or custom-ID entry in Advanced.

Both the UI creation gate and native preflight require authenticated remote catalog
evidence. Missing, cached, fallback, unknown, and disconnected evidence cannot
validate Advanced creation. Databricks supplies remote evidence after its catalog
request; this does not guarantee inference permission or quota. Refresh does not
save configuration or restart an agent.

Codex remains unavailable in the harness selector. This checkpoint does not add
Codex authenticated discovery, API-key catalog intersection, or an ACP provenance
extension. Those remain prerequisites for enabling the strict Codex Advanced flow.
Validation uses synthetic catalog/IPC tests; live account and rendered desktop
acceptance remain outstanding.


## Approved decision and implemented Codex boundary

The user approved matching current Buzz's Codex trust boundary: check CLI login
separately and trust the configured adapter's advertised choices. Fresh remote
provenance is not a prerequisite for Codex. The earlier strict-policy Codex blocker
above is superseded; Databricks retains its authenticated remote-catalog policy.

Codex is now selectable. Shared discovery returns `source: codexAcp` and
`catalog: adapter`, deliberately not `remote`. Refresh asks the adapter again; it
does not bypass its internal cache. Model selection is checked against its list
before `session/set_config_option`; effort choices come from the confirmed selected
model's returned configuration. Native preflight enforces the same trust policy.
Rejected selections keep other advertised choices available and cannot authorize
creation. Errors never expose raw adapter stderr or protocol error details.

Synthetic tests exercise the actual bounded subprocess transport, separate login,
model-dependent effort, rejected/removed model recovery, output limits,
cancellation/reaping, and identity creation gating. Mounted picker tests exercise
adapter-trusted effort selection. Launch command tests check shared context and
Default/Advanced override behavior. Live account and GUI/inference testing remain
outstanding; no account credentials or user Codex configuration were changed.
