# Local agent controls

This slice adds an isolated editor and a TypeScript projection of the native host.
It is **not yet wired into the existing Agents page**. The read-only compatibility
library remains separate. Native integration, packaged runtime and wake-on-mention
acceptance must land before this replaces old Buzz.

## Try the editor without touching real agents

From the `pinky/agent-editor` worktree:

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
  Construct once using `createNativeAgentControl()` at app composition, expose its
  `AgentControl` interface to the plugin, and dispose only with the app service.
- `control-native.ts`: the five named native IPC commands. Browser returns an
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
- Protected composition/plugin API/author contracts and existing AgentsPage/index
  remain integration-owner work after human approval. No runtime code was copied
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
These do not prove native IPC,
persistence, secure custody, process teardown or a working listener.

The integration batch still needs `just scan`, protected wiring review, native
controller tests, bundled runtime verification and an attended packaged workflow
with old Buzz stopped and an explicitly approved isolated identity. Live agents
must not be cut over merely because this browser fixture works. The legacy reaper
and cross-app duplicate listener risks need their own native acceptance evidence.
