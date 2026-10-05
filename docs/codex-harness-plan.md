# Codex harness implementation plan

Add Codex as an optional harness when creating or editing a local agent. Reuse
the user's installed Codex CLI and login, persist the agent's behavior, and run
it through Buzz ACP. Implement this through six dependent PRs, beginning with
a shared harness configuration policy that also serves existing integrations.

This is the agreed implementation plan from October 5, 2026. It records planned
acceptance checks, not completed implementation or testing. The source review
used buzz-app main at `4d5e7572`, the previous local feature branch at `56e46afb`,
and block/buzz at `ec7ea38f6`. Recheck the affected owners against current main
before implementing each layer.

## Product decisions

- **Bind to the installed CLI.** Readiness, model discovery, connection testing,
  and execution must use the same selected Codex CLI, adapter, credential and
  configuration context, workspace, and effective environment. An adapter's
  bundled engine must not silently replace the user's selected CLI.
- **Default delegates to Codex.** Store the Default choice without model or
  effort overrides. Resolve defaults through the user's effective Codex context
  at execution time; do not substitute Buzz device-wide model/effort defaults
  or freeze discovered values into the saved agent. Codex owns configuration
  precedence, including applicable workspace configuration.
- **Advanced requires settings.** The user must explicitly choose a model and
  a supported effort value. Choices come from discovery for the selected model.
  Unknown capability metadata is not proof that effort is unsupported. For
  integrations that confirm no effort control exists, represent that explicitly
  rather than requiring a fictitious value.
- **Create tests the connection.** After Create is clicked, the backend tests
  the submitted configuration with a minimal real inference request before
  creating the agent identity or persisting its record. Advanced validation
  must verify that the requested model and effort were accepted; a response
  using fallback settings does not pass. The test must not publish a channel
  message or invoke agent tools. This action can consume the user's inference
  quota and should be explained in the creation flow.
- **Failure keeps the modal open.** Preserve every draft value and show a safe,
  actionable error. A failed or cancelled test creates no agent. Retry must
  create at most one identity. If a later startup/profile step fails after
  persistence, retain the saved identity and reuse existing recovery controls.
- **Keep full access.** Codex execution retains the full-access behavior approved
  for the previous implementation. Preserve current Buzz owner authorization,
  identity protection, and process containment; full access is not permission
  to weaken those boundaries.
- **Credentials remain Codex-owned.** Multiple agents may share the user's CLI
  login. Creating an agent does not create an inference account. Codex does not
  get the provider/API-key form used by provider-configured harnesses.
- **Effort is in scope.** Model and effort UI ship together in PR 5. Preserve
  current main's Save/restart behavior: running agents restart when effective
  settings change. The old branch's Save-without-restart rule is superseded.

Connection errors must retain their meaning:

| Backend evidence | User feedback |
| --- | --- |
| Confirmed model access rejection | This model is not accessible. Choose another model. |
| Rejected effort | This effort level is not available for the selected model. |
| Missing authentication | Sign in with your Codex CLI, then try again. |
| Quota or billing failure | Explain the reported limit; do not label the model inaccessible. |
| Timeout or network failure | Could not complete the connection test. Try again. |
| Unknown or unconfirmed applied settings | Explain that validation could not confirm the requested settings; do not report success. |

Login and an ACP catalog establish authentication and advertised choices, not
guaranteed model entitlement. Even a successful Create test cannot guarantee
future quota or availability.

## Existing code and previous work

Current main already owns the lifecycle we need:

- [Agent control contract](agent-control.md) and
  [shared agent selection](agents.md#shared-agent-selection).
- [Native harness choices](../src-tauri/src/agents.rs),
  [harness editor](../src/bundled/agents/AgentHarnessEditor.tsx),
  [shared settings](../src/bundled/agents/AgentSettingsFields.tsx), and
  [creation dialog](../src/bundled/agents/AgentCreateDialog.tsx).
- [Native model requests](../src-tauri/src/agent_models.rs) and
  [frontend request cancellation](../src/features/agents/models.ts).
- [Saved configuration](../crates/agent-controller/src/config.rs),
  [storage](../crates/agent-controller/src/store.rs),
  [default resolution](../crates/agent-controller/src/agent_defaults.rs), and
  [runtime launch](../crates/agent-controller/src/runtime.rs).
- [Pi context and preflight](../crates/agent-controller/src/pi.rs),
  [process supervisor](../crates/agent-controller/src/supervisor.rs), and
  [pinned runtime](../runtime/agent-runtime.json).

The previous implementation is historical reference, not a patch to merge whole:

- [Previous PR 178](https://github.com/block/buzz-app/pull/178) and
  [implementation ledger](https://github.com/block/buzz-app/blob/e68dfaaaf248d59034d6e0e3c073e05a45053f3e/docs/add-codex-harness/README.md).
- [HarnessConfigurationPolicy and Default/Advanced types](https://github.com/block/buzz-app/blob/e68dfaaaf248d59034d6e0e3c073e05a45053f3e/crates/agent-controller/src/config.rs).
- [Shared Codex context](https://github.com/block/buzz-app/blob/e68dfaaaf248d59034d6e0e3c073e05a45053f3e/crates/agent-controller/src/codex.rs),
  [ACP discovery](https://github.com/block/buzz-app/blob/e68dfaaaf248d59034d6e0e3c073e05a45053f3e/src-tauri/src/agent_models/codex.rs), and
  [authentication and catalog trust decisions](https://github.com/block/buzz-app/blob/e68dfaaaf248d59034d6e0e3c073e05a45053f3e/docs/add-codex-harness/authenticated-discovery.md).
- [Execution boundary investigation](https://github.com/block/buzz-app/blob/e68dfaaaf248d59034d6e0e3c073e05a45053f3e/docs/add-codex-harness/acp-boundary-comparison.md) and
  [applied session settings design](https://github.com/block/buzz-app/blob/e68dfaaaf248d59034d6e0e3c073e05a45053f3e/docs/add-codex-harness/applied-settings.md).

The historical links use a locally available remote-branch snapshot. They may
contain superseded decisions; the product decisions above take precedence.
In particular, do not copy the exact adapter 1.3.0 restriction, bundled-engine
default, or unrelated OpenAI setup work. Main has since gained bundled Goose,
provider connection tests, newer Pi preflight behavior, and protection controls.

Original Buzz provides additional implementation evidence:

- [Runtime catalog](https://github.com/block/buzz/blob/ec7ea38f6/desktop/src-tauri/src/managed_agents/discovery/catalog.rs) and
  [adapter compatibility checks](https://github.com/block/buzz/blob/ec7ea38f6/desktop/src-tauri/src/managed_agents/discovery.rs).
- [Model discovery command](https://github.com/block/buzz/blob/ec7ea38f6/desktop/src-tauri/src/commands/agent_model_process.rs) and
  [ACP session model and effort application](https://github.com/block/buzz/blob/ec7ea38f6/crates/buzz-acp/src/pool.rs).
- [Agent configuration rules](https://github.com/block/buzz/blob/ec7ea38f6/desktop/src/features/agents/AGENTS.md),
  [product vision](https://github.com/block/buzz/blob/ec7ea38f6/VISION.md), and
  [agent vision](https://github.com/block/buzz/blob/ec7ea38f6/VISION_AGENT.md).

The inspected original Buzz checks for adapter 1.10.0 or newer. Establish a
tested CLI/adapter combination for this port rather than treating either
repository's version rule as sufficient compatibility evidence. Also verify the
actual runtime pinned by buzz-app; it may differ from the reference checkout.

## PR stack

Use a GitHub-native chain of dependent PRs; Graphite is not required. The base
of each PR is the preceding feature branch:

```text
main
  PR 1  Shared harness configuration policy
    PR 2  Codex binding and readiness
      PR 3  Model and effort discovery
        PR 4  Persistence execution and Create validation
          PR 5  Complete Create and Edit UI
            PR 6  Observed runtime settings
```

Open layers as drafts, link their dependencies, and merge bottom-up. After a
parent merges, update remaining branches using the correct previous-parent
boundary and retarget the next PR to main. Build and review incrementally rather
than completing all six before the first merge. Each PR includes its own tests
and documentation. Assess the combined feature diff as well as individual PRs.

### PR 1 Shared harness configuration policy

Define one native policy for authentication ownership, provider configuration,
supported Default/Advanced modes, model requirements, and effort discovery.
Expose that policy through the existing harness snapshot so shared UI and native
validation consume the same authority. Wire existing harnesses to it while
preserving their current behavior and stored records.

Provider authentication remains provider-specific: one harness-level
`needsApiKey` boolean cannot describe API keys, OAuth, and CLI-owned login.
Static policy describes the integration; models and allowed effort values come
from live discovery. This PR introduces no Claude Code integration or new
provider registry. Start from the previous HarnessConfigurationPolicy, adapting
its mappings to current main rather than copying its outdated harness cases.

**Automated acceptance:** table-driven policy validation, accurate IPC projection,
mounted controls driven by policy, and regression tests for existing records,
defaults, provider credentials, and custom executables.

**Local app acceptance:** open Create, Edit, and Agent defaults for Buzz Agent,
Goose, and Pi. Check provider/setup fields, harness switching, saved/custom
values, and save/reopen behavior. No existing agent should be migrated or
reconfigured by this change.

### PR 2 Codex binding and readiness

Register Codex's policy. Resolve the selected CLI, adapter, and interpreter in a
shared native context. Bound and sanitize version/login probes. Distinguish
missing tools, incompatible versions, logout, configuration errors, and timeout.
Expose setup status and manual recovery in Settings; keep creation unavailable
until its complete execution path is ready. Preserve environment isolation.

**Automated acceptance:** executable and interpreter resolution, context equality
between probes and launch, all readiness failure categories, cancellation,
output limits, and process cleanup. Reuse current containment infrastructure.

**Local app acceptance:** launch normally and through a GUI with a minimal PATH;
confirm the intended CLI/login is found. Use an isolated Codex context for
missing-login and configuration failures, repair it, and verify Check again
recovers without reopening the app. Do not log out the user's ordinary CLI.

### PR 3 Model and effort discovery

Extend the existing model-request service with bounded Codex ACP discovery.
Return model IDs, labels, reported defaults, and model-specific effort options.
Preserve successful-empty, unknown, and failed discovery as distinct states.
Reuse tickets, cancellation, and stale-result fencing. Refresh is headless and
must not erase saved selections or automatically launch authentication.

Evaluate the pinned `buzz-acp models` command first. Add direct adapter transport
only for required metadata the existing command cannot supply. Avoid probing
every model's effort options whenever an editor opens.

**Automated acceptance:** production parser/transport tests with a controlled ACP
fixture; malformed/oversized responses, missing metadata, empty catalogs, changed
models, rejected options, timeout, cancellation, and stale-context responses.

**Local app acceptance:** retrieve the real adapter's models and selected-model
effort choices, refresh, change selection, and cancel. Use a Settings surface if
available, otherwise a native integration entry point. Record that distinction;
opening the app alone is not evidence for a backend-only path. No inference
prompt is required for catalog discovery.

### PR 4 Persistence execution and Create validation

Persist Default/Advanced intent through the existing revision-checked store.
Launch through bundled Buzz ACP, the Codex adapter, and the bound user CLI with
full access. Recheck readiness outside the controller lock, then fence launch by
the current revision. Retain existing authorization, protection, lazy workers,
mention replay, restart, and Stop behavior.

Implement the minimal real connection test before identity creation. Bind its
result to the submitted configuration and effective context; changes or
cancellation invalidate it. Require confirmation of Advanced settings rather
than accepting a silent fallback. Connection tests and discovery must not lend
the agent's identity credentials to Codex unnecessarily.

**Automated acceptance:** persistence round trips and legacy compatibility;
Default emits no inherited model/effort override; Advanced requires explicit
valid settings. Cover failed/cancelled tests with zero identity/store writes,
duplicate Create requests, stale validation, exact launch context, full-access
configuration, startup cancellation, Stop, and child cleanup.

**Local app acceptance:** use a native integration driver for the real Create
path until PR 5 exposes it. Exercise Default and Advanced, inspect the agent in
the app, mention it, and verify one signed reply in the correct channel.
Stop/start and relaunch the app; verify the same identity and saved behavior.
Confirm failed validation leaves no newly created agent or listener. Report
the driver-assisted scope honestly; this is not final UI acceptance.

### PR 5 Complete Create and Edit UI

Ship model and effort controls together. Add Harness > Codex, Default/Advanced
selection, CLI readiness, and model-specific effort choices. Omit provider,
Databricks workspace, and app-owned API-key controls for Codex. Show Testing
connection after Create, retain all draft values on failure, and allow correction
and retry within the same modal. Include Edit, Duplicate, and relevant Agent
defaults surfaces without introducing competing configuration ownership.

**Automated acceptance:** mounted form tests for modes, required fields,
capability loading, stale model/effort choices, double clicks, error categories,
draft preservation, retry, and late results. A representative browser journey
proves form/service wiring and keyboard behavior; use lower-layer tests for the
full failure matrix. Audit accessible labels and focus behavior.

**Local app acceptance:** complete Add agent > Codex > Default/Advanced > Create
> connection test > saved agent > mention > reply. Exercise model, effort,
authentication, and network failures; the modal stays open with its draft.
Correct and retry to create exactly one agent. Verify edit, duplicate,
save/reopen, and app restart. Exercise an existing provider flow as regression
coverage. This is the complete creation milestone, including effort controls.

### PR 6 Observed runtime settings

Report requested settings separately from model/effort observed in real
conversation sessions. Include session and observation time, rejected settings,
and known fallback. Show not reported before evidence exists. Reuse existing
activity/diagnostic ownership; discovery and a running PID are not runtime
configuration evidence.

The previous branch used encrypted relay observation, which also publishes
broader prompt/tool activity. Choose that transport explicitly before enabling
it; filtering the settings UI does not restrict what the observer publishes.

**Automated acceptance:** production event projection for applied, missing,
rejected, and fallback settings; multiple sessions, out-of-order events,
eviction, restart/community boundaries, and safe field projection. Old evidence
must not certify a newer launch or newly saved configuration.

**Local app acceptance:** observe a fresh Default and Advanced conversation.
Verify not reported before session evidence, then independently reported model
and effort. Exercise rejection/fallback and restart. Check packaged-app behavior
when its observation transport differs from development.

## Testing and review workflow

Follow [contributing](contributing.md#interactive-product-iteration) and the
[agent contributor guide](../AGENTS.md). Use the pinned Hermit tools and
`bin/just desktop` for native app acceptance. Coordinate native rebuilds and
relaunches; frontend-only iteration can use hot reload. Never treat a browser
fixture as proof of CLI, Keychain, process, or real-account behavior.

During iteration, run focused checks and let the human try the app. Before
review, complete affected tests, mandatory hooks, relevant CI, and each PR's
live acceptance. Do not make routine `just scan` or duplicated broad suites a
gate for every feedback round. Use controlled fixtures for hard-to-reproduce
quota, effort-rejection, and timing failures; label them simulated rather than
claiming real-account evidence.

Before marking a PR ready, complete agent review, agent exercise of the changed
behavior, and human confirmation of the affected workflow. Record the checked
commit, CLI/adapter and runtime versions, automated commands/results, real app
steps/results, simulated failures, and deferred platform/package checks. Keep
credentials and raw private session data out of PR evidence. Documentation-only
work needs content/link/diff checks and human review, not app builds.

For the complete feature, explicitly prove:

1. Default stores no model/effort override and follows the effective Codex context.
2. Advanced settings are accepted and observed; a model's self-description is
   not evidence of applied settings.
3. Failed Create preserves the draft and creates no identity or listener.
4. Correct-and-retry creates exactly one agent.
5. Restart preserves identity and explicit behavior while Default stays delegated.
6. A confirmed mention produces a signed reply in the intended channel.
7. Existing harness/provider creation and editing still work.

## Remaining decisions and boundaries

- **Edit validation:** Create testing is agreed. Confirm whether changing model,
  effort, or other execution settings during Edit should also require a real
  test before Save. Recommendation: test execution-setting changes, skip
  name-only edits, and preserve the saved/running agent if validation fails.
- **Later runtime rejection:** Create validates one point in time. Decide whether
  a later rejected Advanced selection stops that turn or allows an explicitly
  reported fallback. Inspect the pinned ACP runtime before promising either;
  strict enforcement may require a focused upstream change and runtime pin.
- **Observation transport:** confirm the PR 6 transport and its publication scope.
- **Compatibility and platforms:** establish the tested CLI/adapter combination
  and supported operating systems before enabling Codex there. Do not import
  the previous Unix-only discovery path while implying Windows support.
- **Deferred scope:** automatic installation, in-app Codex login, Claude Code
  support, unrelated provider/API-key work, and broad lifecycle or packaging
  rewrites require separate scope. A concrete compatibility blocker should be
  identified and split into a focused prerequisite, not hidden inside a UI PR.

This plan does not synchronize ChatGPT preferences, rewrite the user's Codex
configuration, or introduce per-agent inference accounts.
