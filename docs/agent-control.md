# Local agent controls

The real Agents page now receives one app-owned native capability. Native IPC uses
persistent settings and the controller, not the in-memory editor fixture. The
read-only old library stays separately expandable. **This is an editing checkpoint,
not a replacement runner:** Start/Restart and credential import are blocked natively
and in the UI until OS credential acceptance, independent runtime packaging and
cross-app ownership protection are complete. Old Buzz still owns live replies.

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

## Remaining runtime boundary

Native host holds one serialized controller for the app lifetime; page/plugin/
community disposal only drops observations. App exit fences queued requests and
calls shutdown. This checkpoint deliberately does not restore enabled intent or
attach PlatformCredentials: bundling and exclusion are not yet ready, and toggling
a saved enabled flag cannot bypass that native gate. The connected page reports
`runtimeAvailable: false` and `importAvailable: false`.

The app's existing native identity/relay/media path remains separate work; the
preview does not depend on or certify it. Packaging, truthful listener/work state,
real Keychain prompts/ACLs and isolated mention → reply → sleep → Stop acceptance
are still outstanding. Do not cut over live agents on the strength of this editor.

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
- Import previews only the chosen installed/development library. It exposes the
  source path and exact selected keys/destinations; nothing selects all by default.
  Only explicit commit imports, always disabled. No key minting, enrollment or
  source-store write. Native must reject changed source and duplicate ownership.
- Operations are serialized in this projection, and old pre-write reads cannot
  overwrite newer command evidence. Failed reads/commands retain the last snapshot
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
environment patches retain their existing semantics. No execution/import gate changes.

- Native `agent_models.rs` owns one ticketed, 180-second operation lane, separate
  from the controller lock. Only Connect can open a browser; Refresh is headless.
  Cancel, context change, page unmount and root disposal retire the ticket. Native
  admission remains occupied until the old task's future has actually dropped.
- The immutable `buzz-agent` dependency is pinned to
  `84b0fd04b7831657df2873c3a835412f47cebb03`; no local-checkout dependency. It owns
  OAuth PKCE, redirects/destination enforcement, refresh, catalog parsing/filtering
  and per-page bounds. Native rejects over 10,000 projected models or oversized IDs.
- Credentials remain under this app's `agent-controller/databricks-connections/`
  plus a canonical-host SHA256 directory and the helper's strict namespace.
  Unix directories are owner-only; helper token files are owner-only. They are
  **not Keychain-encrypted**; other code running as your OS user can access them.
  Non-Unix helper persistence remains memory-only. No old Buzz cache/Keychain or
  ambient `DATABRICKS_HOST`/`DATABRICKS_TOKEN` is read.
- Disconnect removes this app's cache for the explicitly displayed workspace;
  it does not revoke browser sessions or tokens at Databricks. Cancel may happen
  after successful authentication; use Disconnect if credentials should be removed.
- Workspace/filter fields are lookup context, not saved harness settings. Saved or
  draft environment overrides take precedence; conflicting inputs fail before
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
5. Re-enter the same workspace after reload (lookup context is not saved), then
   **Refresh models**. It may refresh this app's token, but must never open sign-in.
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
`databricks-connections/<SHA256-of-canonical-origin>/databricks-strict/`.
After quitting, inspect the printed **temporary profile parent** in Finder and move
that `buzz-agent-editor-*` folder to Trash. It contains this disposable sample,
plugin profile and any remaining Databricks cache; never remove the old Buzz
library or the repository. This does not sign out the browser or revoke provider
tokens. The separate preview WebView may retain noncredential appearance state.

App native Connect/refresh-after-reload/Disconnect acceptance is still pending.
The source was built and synthetic native commands were exercised; no claim is
made that a person has completed this checklist in the new app yet.
