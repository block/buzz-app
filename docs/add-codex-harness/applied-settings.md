# Applied model and effort reporting — Step 6

Status: implemented for review, September 29. Phil approved the existing
encrypted observer route. Managed Codex launches now enable observer publishing;
other harnesses retain their previous behavior. Existing agents need a restart.

## User outcome

In an agent's details, distinguish saved settings from settings reported by a
real conversation session. Report model and effort separately. Do not turn
discovery results, process-running status, silence, or a model's self-description
into evidence that settings were applied.

Show the session and observation time behind the result. Multiple workers can
have different sessions: one session's result must not be presented as a global
setting for every conversation. Before the first lazy worker session exists,
show that runtime settings have not been reported yet.

## Evidence available in the pinned runtime

Inspected the installed source for runtime revision
`48884848f566d02c42ce07636636c4ad5f164c27`:

- `pool.rs` emits `session_config_captured` after startup model and effort
  handling. It reports post-selection config options and model state, retaining
  the initial state on model rejection. Successful effort application patches
  the captured current value; rejected effort leaves it unchanged.
- `control_result` reports rejected or unsupported model selections. Effort
  rejection has no equivalent dedicated structured outcome in this version.
  A value mismatch can establish a difference, but not its specific cause.
- `managed_agent_runtime_lifecycle` includes `startNonce`; session config
  events do not directly include that nonce. Current-launch correlation must
  be proved, or the UI must explicitly present last-observed session evidence
  without claiming it describes the current launch.
- The observer module is private. Existing public runtime integration does not
  expose a local settings-only stream.

The app already has owner-key decryption in `dev/agent-observer.mjs`, generation
fencing in its relay pipeline, and bounded session-owned activity storage in
`src/features/agents/activity.ts`. Managed launches currently set
`BUZZ_ACP_RELAY_OBSERVER=false`.

## Transport choice

The smallest app-only route reuses the encrypted relay observer. Enabling it
also publishes broader ACP activity, including prompt/tool events, encrypted
to the owner. Filtering the settings UI does not prevent that publication.

The alternative is an upstream settings-only local channel, followed by a new
immutable runtime pin and an app consumer. That expands work into the reference
repository and runtime packaging; it is not an app-only diagnostics patch.

The existing Step 0 design required this choice to be explicit; Phil selected
the observer route. This does not change runtime fallback behavior or introduce
live model controls.

## Reporting contract

| Evidence | Report |
| --- | --- |
| No real session result, disconnected observation, or uncorrelated launch | Not reported / current settings unverified |
| Runtime reports model or effort | Observed value, session and time |
| Explicit choice matches the reported value | Requested value observed |
| Explicit model rejection or unsupported outcome | Requested model was not applied; show reported fallback only when known |
| Requested effort differs from the reported value | Requested effort was not applied; do not invent a rejection reason |
| Missing effort metadata | Effort not reported; do not claim unsupported without evidence |
| Save changes settings while a session runs | Preserve running-session evidence separately from saved choices |

Only bounded model/effort values and safe outcome categories belong in the new
projection. Do not surface raw protocol errors, prompts, credentials or tool
arguments in the settings panel. Reuse existing lifecycle and subscription
owners; no new polling loop or persistent cache.

## Implementation and acceptance checks

The editor now shows up to five last-reported sessions, projecting only bounded
model/effort values and fixed rejection categories from the existing activity
records. It owns a lease on the existing subscription, with no additional socket,
polling loop or persistent cache. Owner/channel/community checks and generation
clearing remain with the existing activity owner.

Startup configuration has a null session ID in this pinned runtime. The
projection joins it to a later new-session resolution using the exact agent,
worker index, turn and channel, and checks sequence ordering. Model rejection
uses the runtime's control result. Effort rejection additionally requires a
matching startup config request and JSON-RPC error response before capture;
raw error messages never enter the projection.

The UI deliberately reports historical session facts, not current-launch
confirmation. Saved changes never relabel an old report. Settings disappear
when their source records are evicted or cleared. The observer is live-only:
opening the editor after setup may miss the report, and an existing session
does not necessarily resend its settings. Create a new conversation session
while observation is connected to obtain new evidence.

Transport support follows the existing activity feature: the development broker
supports owner-encrypted telemetry; packaged transport without that broker may
report unavailable. This slice does not add another decryption or transport path.

Test production-connected behavior for initial defaults, explicit model/effort,
model rejection, effort mismatch, missing metadata, multiple sessions, duplicate
and out-of-order frames, restart/community changes and late results. Test Save
without restart and stopped-agent display. Keep raw observer payloads out of the
settings projection. Verify the native launch flag and existing decryption
boundary, then exercise a real Codex conversation session before claiming live
acceptance. No model-list or discovery probe can substitute for that check.

Checked implementation: 104 distinct tests across the projection, mounted
settings/editor, existing activity lifecycle, Agents page, profile runtime and
encrypted observer boundary passed. Both native launch checks (Codex enabled,
other harness unchanged), TypeScript, formatting, controller Clippy and native
app build passed. Independent review found no blocking issues. Attended live
Codex reporting and packaged transport acceptance remain open.

To try: restart the native development app and the Codex agent. Keep Agent
Activity enabled and connected, send the agent a message in a new conversation
session, then open Edit agent and inspect Last reported session settings.
Expect a session ID/time and independently reported model/effort, or explicit
unknown values. Default settings must not acquire saved overrides. A rejected
choice must show a fixed failure description rather than raw protocol errors.
