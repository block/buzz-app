# Local agent controls

The real Agents page now receives one app-owned native capability. Native IPC uses
persistent settings and the controller, not the in-memory editor fixture. The
read-only old library stays separately expandable. **Normal native startup now enables
the local management loop when its immutable runtime resources are staged.** The
disposable editor still blocks execution and credential import. The real-agent
handover requires independent review and an attended trial; old Buzz still owns
live replies until that separate switch.

## Try the connected desktop with disposable sample data

From the feature worktree, after an attended launch is agreed:

```sh
bin/pnpm install --frozen-lockfile
bin/node scripts/agent-control-preview.mjs
```

This opens **Buzz Agent Editor Preview** using the real app/native IPC. It uses a
separate app identifier/webview storage, temporary plugin/settings directories,
and a Vite configuration with **no dotenv loading or live broker**, at loopback
port 1445 (fails if occupied). It seeds one artificial public identity with no
private key. Its synthetic enabled flag lets you exercise Stop, but the native
launch gate prevents startup regardless of that flag. The directory remains
printed and retained for inspection.
`--prepare-only` prepares these files but does not launch an app or dev server.
Native watching is disabled, so source changes cannot trigger an unattended native
relaunch. Frontend Vite hot reload remains available; coordinate edits during sign-in.

Open Agents, edit the sample name/prompt/harness/environment and Save. Reload the
window to verify disk persistence; compare Saved revision. Invalid arguments or
reserved environment keys should retain your draft and report a safe error.
Start/Restart and Import selected identities must be disabled. No worker can wake.
Stop only persists disabled intent in this checkpoint. Quit closes this app; do
not close old Buzz. No GUI acceptance is implied until a person tries this.

Preview selected library is keyless/read-only but reads the explicitly selected
old library. Skip preview to keep the exercise wholly synthetic. No background
library scan, Keychain operation, live import, relay connection or live agent
start/stop is performed by this launch path. Databricks Connect is now an optional
explicit browser sign-in; its app-isolated credentials persist under the printed
temporary directory until Disconnect or manual cleanup. Never put real credentials
in sample fields. `BUZZ_AGENT_CONTROL_HOME` is a native process-only storage override, must
be absolute, and cannot select an import source. Normal startup uses this app's
`app_data_dir/agent-controller`, never the old library as a destination.

## Runtime boundary

Native host holds one serialized controller for the app lifetime; page/plugin/
community disposal only drops observations. Normal startup restores saved enabled
intent using app-owned Keychain custody and manifest-verified resources. Preview
startup uses a rejecting credential adapter and never restores. App Quit fences
pending starts and stops owned processes, retaining enabled intent for next launch.
A pending OS credential dialog does not hold the controller; Stop, Disconnect and
Quit retire late starts. Save during a credential wait requires an explicit retry.

The app's native identity/relay/media path remains separately owned work. The
management-only launcher below intentionally disables the dev broker, so its
fixture channel UI cannot prove live replies. Account integration, native Keychain
consent and mention → reply → idle wake → Stop acceptance remain trial gates.

## Older in-memory editor fixture

From this feature worktree:

```sh
bin/pnpm install --frozen-lockfile
bin/pnpm exec vite --config tests/fixtures/agent-control.vite.mjs
```

Open <http://127.0.0.1:1444/tests/fixtures/agent-control.html>. Ctrl+C stops the
server. It binds to loopback, fails if that port is occupied, and deliberately
uses a separate Vite configuration with no environment-file loading or live
broker. It does not launch a native app, read libraries/Keychain, connect a relay,
or start processes. Identities and persistence are simulated in memory; reload
resets the fixture. Use sample input, not real credentials.

Try prompt/name/harness editing, Save then Restart, rejected saves, a newer saved
revision, runtime unavailable, appearance, page navigation and import from either
explicit source. Import candidates show their exact public key and relay. In this
fixture the controls simulate native responses, not agent execution.

## Ownership and handoff

- `features/agents/control.ts`: camelCase DTOs and app-owned observable projection.
  `control-service.ts` constructs it once at root app composition and exposes its
  `AgentControl` interface through Cordis injection. Only the app disposes the projection;
  the author contract exposes neither its disposal nor host construction.
- `control-native.ts`: named native IPC commands, including explicit model-request tickets. Browser returns an
  unavailable capability; no fetch fallback, local storage, signing or runner.
- `bundled/agents/AgentControlPanel.tsx`: compose with `{ control }` independently
  of selected community or relay connectivity. It owns only observation and UI
  drafts. Its five-second refresh runs while visible/ready; reads coalesce. On
  errors it stops polling and exposes explicit Retry. Unmount clears the timer,
  not enabled intent or processes.
- Native host owns persistent state, credential custody, process groups, lock and
  duplicate ownership checks, source import validation and sanitized diagnostics.
  It must bound IPC operations and reject with deliberately user-facing strings;
  raw child/OS/parser errors must never cross into these snapshots or rejections.
- Composition and additive author exports were authorized in thread `935caec3`;
  the integration owner wires AgentsPage/index. No runtime code was copied
  from the identity workstream. Packaged native identity remains a dependency.

## User contract

- Start enables host-owned execution; Stop disables future wake and stops active
  work. Native confirmation, not React optimism, determines displayed state.
  App Quit stops owned processes but retains enabled intent for the next launch.
- `running` is **process-alive evidence only**, labeled “Process running · relay
  readiness unverified.” It is not a Listening/Working badge or proof a mention
  can be received. Native wake/readiness acceptance is separate.
- Save uses `expectedRevision`, updates only editable fields and never restarts.
  Saved/running revisions remain distinct. Dirty drafts survive refresh and save
  failure. A newer saved revision blocks overwrite and offers explicit discard;
  the person can copy their edits before discarding. Drafts are page-local and
  are not persisted across navigation/reload.
- Arguments use a JSON string array rather than splitting shell text, preserving
  spaces and literal quoting. Empty/comma-containing arguments are rejected because
  the current ACP transport cannot represent them faithfully. The executable is a per-agent
  harness choice, not a new installation/catalog system. The host must validate
  launch configuration and unsupported imported semantics before execution.
- Harness and Provider choices come from native `harnessOptions` through the
  injected Core snapshot: Buzz Agent (`buzz-agent`) and Databricks v2
  (`databricks_v2`). These are editing suggestions, not installation or execution
  evidence. There is no copied settings subsystem. Custom
  command/provider values remain editable, including absolute paths; model entry
  remains editable beside explicit Databricks Connect/search. Selecting a choice changes only its field, not arguments,
  model/provider defaults or write-only environment overrides. Advanced arguments
  remain a literal JSON array. Old native hosts without this metadata fall back
  to custom entry; restart the sample launcher to rebuild native and see the new
  choices. This creates a fresh sample, not a restart-persistence test.
- Environment values never arrive in snapshots. Inputs are masked write-only
  patches: missing key preserves; string replaces (including empty); null removes.
  Undo omits a patch again. Successful save clears entered values from UI state.
  Browser strings cannot promise zeroization. Unknown native fields stay native.
  Saved `BUZZ_AGENT_MODEL`/`BUZZ_AGENT_PROVIDER` (buzz-agent) and
  `GOOSE_MODEL`/`GOOSE_PROVIDER` (Goose) overrides win over Model/Provider
  selectors; blank selectors do not erase them. ACP uses the same effective model.
- Import previews only the chosen installed/development library and requires an
  explicit secure **Destination community** origin. Old Buzz ignores saved relay
  pins at runtime; blank, stale or malformed saved pins do not route or hide
  identities here. Native validates the chosen destination, shows it beside each
  exact key, and retains it with the preview token through commit. Source or
  destination edits discard selection and invalidate late preview results. Nothing
  selects all by default. Duplicate source keys fail closed even with different
  old pins; changed sources and duplicate destination ownership are rejected.
  Only explicit commit imports, always disabled. No key minting, membership
  enrollment or source-store write. After a failed preview, **Retry status**, then
  correct the destination/source and preview again; never edit the old library to
  work around a destination error.
- Operations are serialized except explicit recovery Stop during a pending
  Start/Restart credential wait. Stop can reach the native fence for that identity
  or another known running identity; only one Stop is admitted at a time. Other
  writes remain blocked until the launch wait settles. Superseded launch success,
  error and finalization cannot overwrite the newer Stop result or unlock its
  pending operation. Old pre-write reads cannot overwrite newer command evidence. Failed reads/commands retain the last snapshot
  and draft with explicit uncertainty. Start/Restart/Save/import require a fresh
  successful host read before retry. Explicit Stop is the only recovery exception:
  it remains available for identities in the retained snapshot, even if that stale
  snapshot says stopped/disabled. Failed durable disable remains unconfirmed;
  Stop is never automatically retried. No process recovery loop in TypeScript.

## Checks and remaining acceptance

`control.test.ts`, `control-native.test.ts`, `agent-edit.test.ts` cover projection
races, unavailable browser, exact IPC payloads, uncertain result handling,
save/restart distinction, literal arguments and environment patch semantics.
`tests/browser/agent-control.spec.mjs` drives the real editor and capability over
the isolated fake host in Chromium/WebKit: dirty refresh, save failure, revisions,
write-only replacement, Stop, unmount without control actions, selected import,
browser unavailability and narrow dark layout. Mounted recovery cases start with
running and stopped snapshots, fail status reads, then exercise explicit Stop
through the real capability; failed durable disable retains uncertainty and drafts.
These browser fixtures do not prove native IPC or persistence.

`src/app/agent-control.integration.test.ts` exercises real app composition, Agents
registration, plugin management, community selection and the native adapter with
synthetic IPC/relay transports. The same injected capability remains functional
through disable/re-enable, two real community session switches and Personal space.
Captured IPC contains only snapshots during those transitions; root disposal fences
further reads without sending Stop. This is not a mounted native GUI test.
`src/plugins/author.test.mjs` builds declarations and independently compiles a plugin
consumer with no host source, checking Context injection and non-exported ownership.
`src-tauri/src/agents/tests.rs` uses the actual command handler and Tauri mock runtime
with temporary disk stores for Save/CAS/Stop, source preview, native gates and
shutdown fencing. These checks do not establish secure custody, process teardown
or a working listener.

The integration batch still needs `just scan`, protected wiring review, native
controller tests, bundled runtime verification and an attended packaged workflow
with old Buzz stopped and an explicitly approved isolated identity. Live agents
must not be cut over merely because this browser fixture works. The legacy reaper
and cross-app duplicate listener risks need their own native acceptance evidence.

## Databricks connection and searchable models (local preview)

After independent auth-boundary review and an attended launch, open Agents → Edit
agent and harness. Select Buzz Agent and Databricks v2, expand **Connect and search
Databricks v2 models**, enter the workspace HTTPS origin explicitly, then click
**Connect**. Complete browser sign-in only if prompted. Back in the app, search by
label or ID and choose a result; the exact ID goes in Model. Save explicitly.
Typing, blank/custom/current models, Save/Discard, arguments and write-only
environment patches retain their existing semantics. The disposable preview still
blocks execution/import; normal native management is described below.

- Native `agent_models.rs` owns one ticketed, 180-second operation lane, separate
  from the controller lock. Only Connect can open a browser; Refresh is headless.
  Cancel, context change, page unmount and root disposal retire the ticket. Native
  admission remains occupied until the old task's future has actually dropped.
- The immutable `buzz-agent` dependency is pinned to
  `84b0fd04b7831657df2873c3a835412f47cebb03`; no local-checkout dependency. It owns
  OAuth PKCE, refresh, catalog parsing/filtering and per-page bounds. The approved
  existing-runtime route retains current Buzz endpoint/redirect semantics; it does
  NOT enforce the earlier preview's strict same-origin/no-redirect policy. Native rejects over 10,000 projected models or oversized IDs.
- OAuth credentials remain under this app's
  `agent-controller/buzz-agent/oauth/databricks/<connection-hash>.json`. Connect,
  native catalog, worker catalog and inference share this exact engine layout.
  Unix directories are owner-only; helper token files are owner-only. They are
  **not Keychain-encrypted**; other code running as your OS user can access them.
  Non-Unix helper persistence remains memory-only. No old Buzz cache/Keychain or
  ambient `DATABRICKS_HOST`/`DATABRICKS_TOKEN` is read.
- Disconnect requires Stop for all owned workers using the displayed workspace,
  retires pending starts for it, and removes only its app cache (retaining the lock
  inode). It does not revoke browser sessions or tokens at Databricks. Cancel may happen
  after successful authentication; use Disconnect if credentials should be removed.
- Save persists workspace/filter with the harness revision; Connect does not save
  or start. Saved or draft environment overrides take precedence; conflicting inputs fail before
  auth rather than querying a misleading catalog. An effective non-v2 provider,
  token override or revision conflict also blocks connection. `BUZZ_AGENT_MODEL`
  produces a visible override warning, never leaks its value or rewrites it.
- Catalogs may be partial; no completeness claim. The pinned helper's labelled
  authenticated-empty defaults are omitted here because they are not discovered
  IDs. Empty/error states keep manual entry available.
- Private build configuration may supply only nonsecret defaults through
  `BUZZ_BUILD_AGENT_ENV` (`DATABRICKS_HOST`, `DATABRICKS_MODEL_FILTER`; the existing
  `DATABRICKS_MODEL` convention is ignored, never chosen automatically). Unknown
  or secret keys fail the build. Unset means no workspace. Default sample launch
  scrubs this input and all ambient Databricks variables. No private release
  pipeline changes are included; enter a workspace explicitly for this preview.

This is a source/native-build checkpoint, not a signed package or live credential
acceptance. Synthetic IPC/browser coverage and upstream SSO harness evidence do not
replace an attended app Connect → models → Save → reload → Disconnect try.


### Attended connection checklist and cleanup

Keep old Buzz running. Use the native launcher above, not the browser-only fixture
or the upstream standalone SSO harness. No Accessibility/screen automation is
required: the person opens the page and clicks Connect. If port 1445 is occupied,
stop only the preview server you own; do not terminate another app.

1. Open **Agents → Sample agent (not runnable) → Edit agent and harness**.
   The sample already selects Buzz Agent / Databricks v2.
2. Expand **Connect and search Databricks v2 models**. Enter the intended HTTPS
   workspace origin, without a token/path/query. No `.env.local` edit is needed.
3. Before Connect, confirm the Model remains `sample-model`. Optionally click
   Refresh: an empty app cache must report unavailable, without a browser.
4. Click **Connect**, approve browser sign-in if asked, and return to the app.
   Search by name or ID. Choose explicitly; verify Model receives the exact ID.
   Search/loading alone must not change it. Save, reload this same window, and
   confirm the saved ID/revision. Re-running the launcher creates a NEW sample.
5. Confirm the saved workspace after reload, then **Refresh models**. It may refresh this app's token, but must never open sign-in.
   Try a custom ID or blank Model and refresh; each value must stay untouched.
6. For cancellation, click Connect/Refresh, then **Cancel connection** while pending.
   A cancelled browser tab may remain open; close it yourself. Save/Stop are not
   held behind network waits. A brief busy error on immediate retry means the old
   task is still dropping; retry explicitly.
7. Enter the original workspace and **Disconnect**. Confirm removal, then Refresh
   should fail headlessly. Changing the workspace does not delete earlier caches.
   Disconnect each used workspace or remove the whole disposable profile below.
8. Quit **Buzz Agent Editor Preview**, then Ctrl+C its launch terminal if still
   running. Keep old Buzz open. Do not delete files while the preview is running.

The terminal prints `Disposable native settings: <temporary-profile>/agents`.
Credentials are under that path at
`buzz-agent/oauth/databricks/`. Old disposable strict-preview caches are not
copied or reused; explicitly Connect again for the existing-runtime route.
After quitting, inspect the printed **temporary profile parent** in Finder and move
that `buzz-agent-editor-*` folder to Trash. It contains this disposable sample,
plugin profile and any remaining Databricks cache; never remove the old Buzz
library or the repository. This does not sign out the browser or revoke provider
tokens. The separate preview WebView may retain noncredential appearance state.

Wes reported successful native preview Connect/model listing at the earlier
`36eefeab` checkpoint. That does not prove this changed cache policy, inference,
refresh/reload/Disconnect or the real-agent management loop.


## Existing-runtime management checkpoint (macOS, attended only)

Build without launching any app or accessing old credentials:

```sh
bin/pnpm install --frozen-lockfile
bin/node scripts/build-agent-runtime.mjs
bin/pnpm build
bin/cargo build -p buzz-foundation
```

`runtime/agent-runtime.json` pins the five tools to published revision
`84b0fd04b7831657df2873c3a835412f47cebb03`. The build script uses pinned Cargo,
`cargo install --git --rev --locked`, scrubs injected Buzz/provider environment,
and stages binaries plus revision/target/SHA256 manifest in
`src-tauri/resources/agent-runtime`. Native build copies them to
`target/debug/agent-runtime`. Generated binaries/manifest are not committed.
Startup verifies the exact tool set, target, revision and file hashes; required
launch tools are rehashed before spawn. No PATH/old-bundle fallback or runtime
download. The manifest detects corrupt/mixed resources, not a same-user attacker
who can replace the app and manifest. Inputs are immutable, not a promise of
bit-identical machine-independent binaries. This build is not a signed installer.

After independent review, a human may launch the persistent management-only app:

```sh
bin/node scripts/agent-control-management.mjs
```

This uses the actual app/native commands, the ordinary app identifier and
persistent native `app_data_dir/agent-controller` (macOS:
`~/Library/Application Support/dev.local.buzz.foundation/agent-controller`).
It does not seed samples or enable preview gates. It disables dotenv/live broker
and native watching; opens **Buzz Foundation — Agent management** at loopback
1445. Frontend hot reload remains enabled. No Accessibility automation is required.
Do not run it alongside the editor preview (same port), or another copy of this
app (same profile lock). `--prepare-only` prints the launch description without
opening a window/server. Quit the named app and stop its terminal when done.

The launcher scrubs ambient Buzz/Nostr/Databricks variables; only explicitly
supplied `BUZZ_BUILD_AGENT_ENV` is retained as a private BUILD input. Native build
validation permits only nonsecret host/filter defaults (plus the ignored old
model-default convention); source contains no internal workspace. Unset means no
workspace default. Runtime tools never embed that private build input. No release
pipeline change or real credential in environment/build configuration is needed.

Attended sequence (not executed by the implementer):

1. Keep old Buzz running while reviewing settings/import; do not Start yet. Choose
   installed/development library and explicitly enter **Destination community**
   (secure origin), then Preview. Review the returned destination beside each exact
   key and explicitly import selected rows. This can prompt for the selected
   legacy `secrets` Keychain blob and creates separate app credentials at service
   `dev.local.buzz.foundation.agents`, account `agent:<key-community>`. Source stays
   read-only; imported rows are disabled. No enrollment/new key or service fallback.
   Refused/missing custody is an explicit blocker, not a reason to migrate keys.
2. Inspect prompt, workspace, harness/provider/model and write-only overrides. Choose
   Buzz Agent / Databricks v2, no arguments. Enter workspace/filter, Connect
   explicitly, select a real model or custom ID and Save. Reload preserves settings.
3. **Before Start, obtain the separate handover agreement.** The human must stop
   old Buzz AND its listeners and keep them stopped. Native refuses detected
   `buzz-desktop`/legacy listener paths, never kills them. Cooperating new-app
   profiles also hold an exact-key/canonical-community OS lock. Neither protects
   against relaunching unmodified old Buzz: no coexistence guarantee.
4. Start, observe process-alive/error state, Save an edit, then Restart. `running`
   means process alive only. An isolated live channel/thread mention and reply,
   idle wake, Stop preventing wake and Quit descendant cleanup must still be
   witnessed; fixture messages in this management-only app are not relay evidence.
   Use an independently working real client, or integrate the separately owned
   Account/native messaging first. Do not repeat the standalone SSO harness.
5. Stop all agents on a workspace before Disconnect. A saved host edit does not
   change the running host; restart first or stop its existing worker. Temporary
   runtime signing files live under private `runs/agent-*` and disappear only
   after confirmed teardown. This is process lifecycle management, not a sandbox
   for arbitrary same-user code that escapes its Unix session.
6. Roll back by Stop + confirmed cleanup of the new owner, Quit, then resume the
   same identity in old Buzz. Never delete the old library or its credentials.

Explicit limits: local Unix execution; native credential import currently macOS;
no conditional attestation, remote/team/mesh runtime; custom harnesses require an
absolute executable and are not certified by the bundled Buzz Agent test. Saved
unsupported configuration stays editable but Start refuses it. OAuth files are
owner-only, not Keychain-encrypted. Cancelled/failed import may leave create-only
app custody for retry but no enabled/configured agent. The previous strict-preview
cache is neither migrated nor reused. Native UI, actual Keychain ACLs, production
TLS/Databricks inference, live relay replies, forced native quit, signed packaging
and other platforms remain unproven by the synthetic checks.
