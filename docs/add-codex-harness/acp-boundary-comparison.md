# ACP boundary comparison — 2026-09-24

Investigation after Codex-test-3 could be created but did not reply to a public
channel mention. This is a source comparison and a local process snapshot, not
live end-to-end acceptance. No production code, credentials, running agents or
messages were changed during this investigation.

## Subsequent alignment

The comparison below records the pre-alignment snapshot. The follow-up restores
adapter-bundled Codex by default, routes CLI probes through `codex-acp cli`, and
adds bounded sanitized listener milestones to Host diagnostics plus OS exit status
to failures. Raw logs, setup-listener recovery and relay observer parity are still
not implemented. A live authenticated mention/reply remains unverified.

## Separate the two workflows

Creation/discovery in buzz-app:

```text
form -> native saved/draft context -> CLI version/login probe
     -> codex-acp initialize -> session/new -> model/effort configuration
     -> validated draft -> identity/attestation/persistence
```

Actual communication:

```text
selected mention -> channel enrollment + confirmed message publication
                 -> native Start (or keep already-running listener)
                 -> validate bundle + credentials + context -> spawn buzz-acp
                 -> relay connection/authentication + owner gate
                 -> channel discovery/subscriptions + accepted mention
                 -> lazy adapter spawn + ACP initialize/session/new
                 -> apply model/effort -> prompt + MCP/tool execution
                 -> buzz messages send -> signed relay publication -> UI
```

Creation does not execute the second path. A PID establishes neither a usable
relay subscription nor a successful Codex prompt. ACP response text is not by
itself proof of a channel reply: the pinned base prompt instructs the agent to
publish human-visible answers using `buzz messages send`.

## Important differences

| Boundary | Original Buzz | buzz-app | Diagnostic consequence |
| --- | --- | --- | --- |
| Runtime binary | Resolves workspace commands, managed tools, sidecars and PATH candidates | Immutable revision `84b0fd04b7831657df2873c3a835412f47cebb03`; manifest hashes checked at initialization and launch | Failures before exec belong to packaging/controller, not Codex authentication |
| Resource lifecycle | Resolver chooses its available executable path; no equivalent manifest gate in inspected launch function | Tauri stages `target/<profile>/agent-runtime`; macOS fresh-inode workaround follows its in-place copy | Our workaround repairs executable signature caching but does not make the entire staging operation atomic; a start during copying can still fail integrity checks |
| Logs/status | Local stdout/stderr log, rotation at open, log-error extraction; relay observer enabled; per-launch nonce and ownership marker | stdout/stderr discarded; relay observer disabled; generic exited-process error | We lose the evidence needed to distinguish relay refusal, owner rejection, adapter initialization and inference failure |
| Environment | Inherits parent environment, augments PATH using managed paths/login shell/nvm, then applies layered settings | `env_clear()`, small allowlist and explicit saved values; pinned tools added to PATH | Deliberate isolation, not a reason to copy the whole original environment. Verify missing required variables individually |
| Underlying Codex | `configure_runtime_cli` only overrides Claude; ordinary adapter 1.3.0 uses its bundled Codex unless configured otherwise | Shared context explicitly supplies `CODEX_PATH` to resolved standalone CLI (observed 0.151.0) | Same ACP adapter version does not guarantee the same Codex engine/configuration behavior. This is a meaningful recent deviation, not a proven fault |
| Working directory | Desktop chooses its default agent work directory and resolves layered definitions/personas/global settings | Per-agent workspace and native saved write-only environment patches | Project configuration/skills can differ; the tested agent workspace is separate from this repository |
| Start readiness | Computes readiness at launch; missing requirements can enter a setup listener rather than an ordinary pool | Creation checks CLI/auth/session; Start validates saved config, tools, attestation and bundle but does not repeat that discovery preflight | Create success can become stale; setup recovery behavior has not been ported |
| Relay authority | Agent key, exact relay, owner attestation; owner fallback allowed when attestation absent | Separate native key custody; requires a verified owner attestation; default owner-only response policy | Both have an author gate. Do not weaken it to test; compare event author with authorized owner and check the actual rejection |
| Mention wake | Replay-floor support, lazy pool, lifecycle/presence evidence | Confirms channel enrollment, publishes mention, then starts exact key/community with replay floor; skips Start if process already running | The wake hook is wired, but process-running is not an application-level listening acknowledgement |
| Model/effort | Applies startup selections through ACP and can publish observer outcomes | Forwards model/effort to the same pinned engine; discovery validates a different short-lived session; runtime observer off | Discovery cannot certify settings applied to a later conversation or reveal runtime fallback |
| Reply tooling | Codex uses buzz-dev-mcp; CLI on augmented PATH; engine supplies standing prompt and context | Same MCP executable role and pinned Buzz CLI on PATH | Tool spawn, sandbox/network access and successful signed CLI publication are additional boundaries after inference |

The new app intentionally does not copy the original settings/lifecycle subsystem.
Original Buzz also has limitations: broad environment inheritance and its
CLI-readiness probe do not establish exact per-agent runtime context or inference.
The comparison is not a recommendation to port those weaknesses.

## Evidence and current diagnosis

Earlier failures were real, but not the whole diagnosis:

1. The deployed listener died with SIGKILL before producing output. macOS logged
   code-signature load error 2. Its bytes still matched the source executable and
   on-disk codesign verification passed. Replacing the inode restored execution.
2. Integrity mismatch occurred during overlapping resource builds. The app also
   retains `RuntimeBundle::new` errors in its initialized controller; Refresh
   status does not reconstruct that bundle. My prior restart explanation was a
   plausible recovery path, not evidence that the non-reply was solved.
3. In the latest observation, the current Foundation process had **three direct
   live buzz-acp listeners**. All five deployed and source manifest hashes matched.
   No recent buzz-acp signature-rejection entries appeared in the inspected window.
4. All three listeners had established outbound TCP connections on port 443.
   This is transport evidence only, not proof of authenticated subscriptions.
5. The only worker descendant observed was `buzz-agent` with `buzz-dev-mcp`.
   **No Codex adapter/CLI worker was observed** under these three listeners.
   The snapshot does not prove Codex was never spawned: it could have failed and
   exited earlier, or returned to idle. PIDs alone do not map each listener to a
   particular saved agent, so do not assign identity from spawn order.

Therefore the current evidence does not justify another model/login change or
another claim that resource rebuilding fixes the reply. The next boundary to
observe is **accepted mention -> lazy Codex worker startup**, while retaining
relay authentication/channel subscription as possible earlier failures.

## Smallest next diagnostic change

Add bounded, native, per-agent startup/exit evidence at the existing process owner:
exit code/signal and sanitized phase/error categories. Correlate with agent ID,
saved/running revision and a launch generation. Capture only bounded subprocess
output and expose allowlisted diagnostics; do not return credentials, raw prompt
transcripts or unrestricted process logs. Do not silently enable encrypted relay
observer transport: that is the separate scope decision already recorded in step 0.

Then perform one attended mention to Codex-test-3 and establish, in order:

1. listener still alive and relay authentication/subscription completed;
2. exact event ID, `h` channel and `p` recipient accepted by the author/mention gates;
3. adapter spawned, CLI identity/context, initialize and session/new succeeded;
4. requested settings applied or explicitly failed/fell back;
5. prompt completed and Buzz CLI reply publication was accepted.

Stop at the first failed boundary and fix that owner. Preserve auth, membership,
integrity and secret-isolation gates. No implementation change was made as part
of this comparison.

## Source anchors

Original checkout (`block/buzz`, inspected at local `ec7ea38f6`):

- `desktop/src-tauri/src/managed_agents/runtime.rs`: command construction/logs at
  480–590, owner/auth and observer at 703–725, environment and generation at 753–797.
- `desktop/src-tauri/src/managed_agents/discovery.rs`: `resolve_command_uncached`.
- `desktop/src-tauri/src/managed_agents/runtime/setup_payload.rs`: launch readiness.
- `desktop/src-tauri/src/managed_agents/storage.rs`: `open_log_file` and
  `meaningful_agent_error_from_log`.
- `desktop/src-tauri/src/managed_agents/access_policy.rs`: owner/allowlist projection.

buzz-app (current uncommitted implementation):

- `crates/agent-controller/src/runtime.rs`: command 12–215; snapshot 328;
  credential request 460; start 509–589.
- `crates/agent-controller/src/codex.rs`: context/interpreter resolution and CODEX_PATH.
- `crates/agent-controller/src/bundle.rs`: manifest and per-executable verification.
- `src-tauri/src/agents.rs`: initialization/restore and native start/credential flow.
- `src-tauri/src/agent_models/codex.rs`: direct discovery session, separate from listener.
- `src/features/agents/mention-enrollment.ts`, `mention-wake.ts`, `control.ts`:
  enrollment, confirmed sends, exact-identity wake and process-running shortcut.
- `src-tauri/build.rs`, `build_resources.rs`: current staging repair and its limits.

Pinned engine source (read-only Cargo checkout at `84b0fd0`):

- `crates/buzz-acp/src/lib.rs`: owner 139; entry point 2454; lazy pool 2531;
  relay connection 2572; owner gate 2599; discovery/subscriptions 2665–2718;
  presence/listening publication 2741.
- `crates/buzz-acp/src/acp.rs`: adapter spawn 455 and environment merge following it.
- `crates/buzz-acp/src/pool.rs`: session/model/effort and prompt execution.
- `crates/buzz-acp/src/base_prompt.md`: explicit message-publication requirement.

The original checkout is newer than the pinned engine. Launch behavior above was
compared to the actual pinned source where it affects this app, rather than
assuming the two revisions are interchangeable.
