# Local agent controls

The Agents page uses one app-owned native controller for creating, importing,
editing and running local agents. Managed cards are keyed by exact identity and
community. Browser-only access keeps the read-only old library; it cannot run
agents. The only product entry point is ordinary desktop startup.

## Normal desktop workflow

Run from the feature worktree with `bin/just desktop`, not a management-only
launcher. The command prepares the pinned agent runtime before starting Tauri;
the first build may take several minutes. Later launches verify and reuse matching
resources, rebuilding missing, stale or corrupt ones. Preparation failure stops
launch rather than opening a desktop that cannot run agents. This opens **Buzz Foundation** using the ordinary live-development
configuration and persistent native settings. Coordinate the native rebuild/relaunch;
quit other Foundation copies first. Saved enabled agents can restore on startup.
Keep imported agents disabled and old Buzz running until an attended handover.

Open **Agents → My agents** for imported identities, their destination community,
process evidence and visible **Start / Stop**. **Edit** remains secondary in the
card’s three-dot menu. Same-key identities at different destinations have separate
cards; actions use native ID/revision, never the display name. Managed controls
remain available when the old library is disconnected, unavailable or archived.

**Add agent** shares the Edit fields and model browser. In the development desktop,
Create generates a native key, obtains the captured viewer's owner authorization,
and saves the agent stopped before publishing its profile. Failed profile publication
has a Retry action on the same saved card; it never creates another identity.
During a Create/profile wait, **Close** leaves the native operation running and
exposes the existing cards' recovery Stop. Closing before creation returns skips
automatic profile publication; refresh status and retry on the saved card. Late
completion never closes a subsequently opened dialog.
Create is blocked with an explanation if this app’s runtime is unavailable;
existing agents and profile retry remain intact.
The dev broker and native host must both support this flow. Packaged human
signing remains unavailable.

**Not imported from old Buzz** is a separate collapsible section. Expanding it
loads installed identities for the connected community; already-managed exact
identities are excluded. Each remaining row says **Not imported** and has its own
**Import** action. Source/destination overrides and source warnings stay under
Import options. Import focuses the imported card and says **Imported, not started**.
It does not start a listener, invite an agent or change the old library.

To use an agent, open a channel and select it from **@ mentions**. The chooser
includes this app's managed agents in that same community. A nonmember is labeled
**Adds to channel when you send**. Selection alone does nothing; Send adds the agent
through the existing outbox, verifies membership, then sends the message. Failed or
unconfirmed additions keep the draft and expose the error; Send retries the same
pending enrollment. A definitively failed addition older than 15 minutes directs
the person to remove its labeled **Add agent** item from Outbox before sending
again; an unknown outcome is never silently replaced. Channel and thread composers
share this behavior. DMs and
other-community agents are excluded. No Agents-page channel picker is needed.

A confirmed outgoing channel or thread mention now starts an exact imported local
agent (public key + community), without a separate Start click. Import itself
remains non-starting. Stop cancels earlier pending mention wakes and active work;
a later deliberate mention can start the agent again. Plain name text without
recipient selection, received history and unconfirmed sends do not start agents.
Start failures appear separately as “Message sent, but…”; do not resend merely
because execution failed. The old-Buzz ownership guard remains in force.

Mention startup carries the earliest relevant pending send timestamp into the
bundled runner's existing replay input (bounded by its 15-minute catch-up limit).
Already-running agents are not restarted. Process state is not proof of a live
reply; imported identities require old Buzz stopped before handover.

The focused Add/Edit dialog contains Name and Agent instructions, followed by
**AI configuration** in dependency order: **Harness → Provider → Model**. Provider
choices come from the selected harness; model discovery uses the current draft.
Existing/custom values remain intact when another field changes. Workspace,
arguments and write-only environment patches remain under **Advanced**;
Start/Stop/Restart and exact identity are under **Runtime and identity**. Save uses
native ID/revision and does not restart. Dirty drafts resist backdrop/Escape;
explicit Cancel/Close discards. Page navigation/reload still discards page-local drafts.

**Browse models** requests the current Databricks catalog on explicit button
activation, including when typing has already opened the local popup. Typing,
focus and ArrowDown navigation never start a model-host request. Existing
app-isolated credentials are used/refreshed first; only an authentication failure
can open browser sign-in. No separate Connect button is required. Errors/cancellation
need explicit Retry; Refresh in **Advanced model settings** stays headless.
Choose a result or enter a custom ID (blank is allowed); Enter or leaving the field
commits typed text, Escape abandons the query. Save, close and reopen to check it.
If no workspace is configured, set it under **Advanced model settings**.

To avoid retyping nonsecret workspace/filter defaults, use the existing native
build input in the shell that starts desktop (replace the example origin):

```sh
export BUZZ_BUILD_AGENT_ENV="$(printf '%s\n' \
  'DATABRICKS_HOST=https://workspace.example.com' \
  'DATABRICKS_MODEL_FILTER=*')"
bin/just desktop
```

This value contains `KEY=value` lines, not a file path. It is read at **native build
time**, not by Vite from `.env.local`; changing it needs a native rebuild. Omit the
filter line to use no filter. Saved per-agent settings/overrides retain precedence.
Tokens/unknown keys are rejected; never put credentials here. The connection cache
remains separate from old Buzz. No private host is committed to source.

## Runtime boundary

Native startup opens `app_data_dir/agent-controller`, never the old library as a
destination. One serialized controller lives for the app lifetime. It restores
saved enabled intent with app-owned credential custody and verified resources.
Page/plugin/community disposal drops observations, not processes. Quit fences
pending starts and stops owned processes while retaining enabled intent. A pending
OS credential dialog does not hold the controller: Stop, Disconnect and Quit
retire late starts; Save during a credential wait requires an explicit retry.
Synthetic native tests inject rejecting or in-memory credentials and runtime
resources. Production has no disposable storage override or preview launch mode.

## Ownership and handoff

- `features/agents/control.ts`: camelCase DTOs and app-owned observable projection.
  `control-service.ts` constructs it once at root app composition and exposes its
  `AgentControl` interface through Cordis injection. Only the app disposes the projection;
  the author contract exposes neither its disposal nor host construction.
- `control-native.ts`: named native IPC commands, including explicit model-request tickets. Browser returns an
  unavailable capability; no fetch fallback, local storage, signing or runner.
- `bundled/agents/AgentControlPanel.tsx`: compose with `{ control }` independently
  of selected community or relay connectivity. It owns only observation and UI
  drafts. Its five-second refresh runs while visible/ready; reads coalesce. A read
  rejected specifically because native startup is initializing or its lock is busy
  stays pending for at most twenty 250ms waits. Genuine errors or exhausted retries
  stop polling and expose explicit Retry; writes are never automatically retried.
  Unmount clears the timer, not enabled intent or processes.
- Native host owns persistent state, credential custody, process groups, lock and
  duplicate ownership checks, source import validation and sanitized diagnostics.
  It must bound IPC operations and reject with deliberately user-facing strings;
  raw child/OS/parser errors must never cross into these snapshots or rejections.

## User contract

- Start enables host-owned execution; Stop disables automatic resume and stops active
  work. A later deliberate outgoing mention can enable execution again. Native confirmation, not React optimism, determines displayed state.
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
  remains editable alongside on-demand Databricks browsing. Selecting a choice changes only its field, not arguments,
  model/provider defaults or write-only environment overrides. Advanced arguments
  remain a literal JSON array. Old native hosts without this metadata fall back
  to custom entry.
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
  destination edits discard candidates and invalidate late preview results. Each
  Import action selects one exact identity. Duplicate source keys fail closed even with different
  old pins; changed sources and duplicate destination ownership are rejected.
  Only explicit Import actions commit, always stopped. No key minting, membership
  enrollment or source-store write. After a failed preview, correct the destination/source
  and choose **Load agents** or **Retry**; both refresh status before previewing.
  Never edit the old library to work around a destination error.
- Operations are serialized except explicit recovery Stop during a pending
  Start/Restart, Import, Create or profile-publication credential wait. Stop can
  reach the native fence for a pending launch or another known enabled/running
  identity; only one Stop is admitted at a time. Other writes remain blocked until
  both operations settle. Superseded success, error and finalization cannot
  overwrite the newer Stop result or unlock its pending operation. Stop does not
  cancel native credential writes: imported/created rows may still commit stopped,
  and profiles may publish. Recover these changes by a fresh status read, never by
  replaying the superseded result.
  Old pre-write reads cannot overwrite newer command evidence. Failed reads/commands retain the last snapshot
  and draft with explicit uncertainty. Start/Restart/Save/import require a fresh
  successful host read before retry. Explicit Stop is the only recovery exception:
  it remains available for identities in the retained snapshot, even if that stale
  snapshot says stopped/disabled. Failed durable disable remains unconfirmed;
  Stop is never automatically retried. No process recovery loop in TypeScript.

## Databricks connection and models

- Native `agent_models.rs` owns one ticketed, 180-second operation lane, separate
  from the controller lock. Only the user-intent Connect IPC action (Browse/Retry) can open a browser; it tries headless discovery first. Refresh is always headless.
  Cancel, context change, page unmount and root disposal retire the ticket. Native
  admission remains occupied until the old task's future has actually dropped.
- The immutable `buzz-agent` dependency is pinned to
  `84b0fd04b7831657df2873c3a835412f47cebb03`; no local-checkout dependency. It owns
  OAuth PKCE, refresh, catalog parsing/filtering and per-page bounds. It retains current Buzz endpoint/redirect semantics. Native rejects over 10,000
  projected models or oversized IDs.
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
  or secret keys fail the build. Unset means no workspace; enter one explicitly if no default is configured.

## Runtime resources

Ordinary `bin/just desktop` and `bin/pnpm tauri build` prepare these resources
automatically. Direct Cargo builds do not run that JavaScript preparation step.
To prepare/build without launching any app or accessing old credentials:

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

## Handover and rollback

1. While old Buzz still runs, review/import only. Choose the installed/development
   library and destination under **Import options**. Import may prompt for the
   selected legacy Keychain blob; it creates separate app credentials at service
   `dev.local.buzz.foundation.agents`, account `agent:<key-community>`. The source
   is read-only and imported agents stay stopped. Refused custody is a blocker,
   never a reason to migrate keys implicitly.
2. Review prompt, workspace, harness/provider/model and write-only overrides.
   Browse models, save explicitly, and verify settings after reopening.
3. Before Start or an outgoing mention, stop old Buzz **and its listeners** with
   the human's agreement. Native refuses detected legacy paths; it never kills
   them. Cooperating new-app profiles also hold an exact-key/community OS lock.
   Neither protects against relaunching unmodified old Buzz: no coexistence claim.
4. Observe a real channel/thread reply, idle wake, Stop cancellation and Quit
   cleanup in the attended workflow. A process-running badge is not relay evidence.
5. Stop agents on a workspace before Disconnect. A saved host edit does not change
   a running worker. Temporary signing files under private `runs/agent-*` disappear
   only after confirmed teardown. This is lifecycle management, not a sandbox for
   same-user code that escapes its Unix session.
6. Roll back with Stop and confirmed new-owner cleanup, then Quit and resume that
   identity in old Buzz. Never delete the old library or its credentials.

## Validation and limits

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
with temporary disk stores for Save/CAS/Stop, source preview, rejecting test credentials/runtime and
shutdown fencing. These checks do not establish secure custody, process teardown
or a working listener.

The isolated browser fixture (`tests/fixtures/agent-control.*`) remains test-only:
no dotenv loading, live broker, native credentials or actual process execution.
It supports the controller, editor-grid and model browser regression suites, not
an alternative product launch mode. Check results belong in the PR at their exact
snapshot rather than as permanent checkpoint claims here.

Local execution currently uses Unix containment; native credential import/create
is macOS-only. Custom harnesses require an absolute executable and are not
certified by bundled Buzz Agent tests. Unsupported settings stay editable but
Start refuses them. OAuth files are owner-only, not Keychain-encrypted. A failed
import can leave create-only app custody for retry but no enabled/configured agent.
No remote/team/mesh runtime or conditional attestation is added. Synthetic checks
do not establish actual Keychain ACLs, production TLS/inference, live replies,
forced native quit, signed packaging or other-platform behavior.
