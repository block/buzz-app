# Foundation hardening plan

> Historical evidence, archived 2026-09-09. This records successive review states,
> not the current plan or release approval; paths, test counts and uncommitted/pushed
> descriptions below refer to their original checkpoints. For maintained decisions
> and open gates, see [foundation status](../status.md); for current commands and
> fixture URLs, see [contributing](../contributing.md).
> Private message IDs and machine-specific evidence paths have been omitted;
> commit IDs, content hashes and recorded validation limits are retained.

Status: **Checkpoint 1 is committed/pushed at `deb1d3101f8909e7d506d354dbe752fc911e1590`; typed relay URLs are committed locally at `a85fda6`. The checked-in browser regression gate is implemented, fully scanned and independently mutation-checked for this local commit. No further push authorized. Native/release gates remain open. Earlier entries below retain their historical state.**

Guidance: owner approval on 2026-09-08 authorizes hardening and moving the complete
Channels plugin under bundled, plus a self-contained Hermit toolchain. Pinky owns relay hardening/integration; Brain owns Channels,
shutdown and tooling, with independent cross-review. Later product gates remain.

Baseline: `foundation-hardening` at `578d3dac0aff2c3d3e568d34bad1a6eb64b68e6b`.
Written 2026-09-08.

## Goal and scope

Make the existing trusted-plugin foundation dependable and easier to navigate,
without a rewrite. Keep ordinary React pages/panels over host-owned identity,
community sessions, authorization, retained data, durable delivery and recovery.

**First checkpoint:** correct access invalidation and teardown, accurate examples,
and explicit code ownership. **Later, separately guided checkpoint:** a supported
external-author contract and two independently built plugins in a packaged app.
Native login and network policy are product work, not incidental cleanup.

We will aim for 10/10, not award ourselves perfection: each slice must clear at
least 9/10 on minimalness, elegance and correctness, backed by behavioral evidence.
A high self-review score never substitutes for tests or a real workflow.

## Keep these boundaries

Preserve `app/`, `plugins/`, `features/`, and `bundled/`; do not introduce a parallel
`core/` tree. Wes explicitly steered the complete Channels experience into
`bundled/channels/` so it demonstrates plugin-owned product code.

| Owner | Responsibility and organization rule |
| --- | --- |
| `src/app/services.ts` | Compose services and coordinate host shutdown. Do not move app orchestration into individual plugins. |
| `src/plugins/` | Keep management/configuration, module loading, executable lifetime and contribution ownership distinct; retain one readiness source. |
| `src/features/communities/` | Own local profile, saved membership, selection and retained session lifetimes. Isolate platform access when adding the native implementation. |
| `src/features/relay/session.ts` | Coordinate one session's reads, live traffic, retained views and write reconciliation; own the access-invalidation boundary. |
| `src/features/relay/store.ts` | Own channel-specific discovery, heads/history and projection behavior; report authoritative access changes rather than pretending reader cancellation purges the whole session. |
| Other relay modules | Keep scheduler, transport, outbox, persistence, profile directory and domain folds as existing concrete responsibilities. No second optimistic cache. |
| `src/bundled/channels/` | Complete Channels plugin: page, components, styles, local interaction state and tests. No connection, signing or durable persistence ownership. |
| Pages/panels and `src/bundled/` | Keep the two extension contracts; distinguish supported author imports from host internals. |
| `crates/plugin-manager/`, `src-tauri/` | Shared installation logic stays in the Rust manager; desktop commands remain adapters. |

## Sequence: small, reviewable slices

### 0. Establish the executable baseline and behavior checklist

- Recheck HEAD and working-tree changes before each slice; preserve unrelated work.
- Restore access to the **pinned** toolchain/dependencies through an approved route.
  The prior review could not resolve required JS packages; do not change versions,
  lockfiles or registry/security policy merely to make checks run.
- Run `just scan` once when available and record commands, commit, dirty diff,
  results and unrelated pre-existing failures. Do not claim a clean baseline until
  it actually runs. Add focused regression cases with each behavior change.
- Keep the existing `just iterate`/`just scan` interface. No new command framework.
- Bring the two broken authoring examples forward as a small docs/test slice alongside
  this baseline work; do not wait for the later external-author milestone.

**Exit:** reproducible validation, or a precise dependency/toolchain blocker.
Pinned dependencies were installed on 2026-09-08 through the then-configured
company registry, retaining all package/lock versions. Hermit setup is included; both `bin/just iterate` and `bin/just scan` now pass
through its exact pins. See [validation and manual checklist](hardening-validation.md).
Sources: `AGENTS.md:3–10`, `docs/contributing.md:12–34`, `justfile:29–42`,
`package.json:21`, `README.md:18`.

### 1. Fix session-wide revocation, without reorganizing around an unfixed bug

**Proposed invariant:** authoritative access loss removes that channel's data from
host-owned read views and prevents obsolete work from repopulating them. It does
not erase copies trusted plugins already made or prove server access is possible.

- Trace explicit denial, signed membership removal and complete-roster removal
  through one session access-invalidation boundary. Partial discovery or a transient
  transport failure is not proof of removal; explicit denial is. Keep cache clearing
  and request cancellation distinct.
- Cover recent evidence, existing/new generic observations, finite read completion,
  channel heads/history, profile/persisted projections and confirmed-local overlays.
  Determine event ownership for broad/ID-only/reference queries, not just `#h`
  request filters. Avoid a second independently maintained authorization model.
- Retain pending/unknown operation IDs and signed bytes. Separate read visibility
  from durable recovery; do not silently delete intent, re-sign retries, or change
  write scheduling as an incidental cache fix.
- Test through `createRelaySession` and the actual store-to-session callback:
  deny/remove → existing and newly opened views; broad and ID-only reads;
  stale read/live results; revoke/regrant; unrelated channels; pending intent.
  Add persistence/confirmed-echo cases where those paths can repopulate a view.

**Exit:** regressions fail on the baseline, pass on the fix, and fail again if the
production invalidation call is removed. Regrant accepts only eligible fresh work.
Sources: `session.ts:70–95,126–164,169–268` and
`store.ts:358–388,531–637,664–699,738–778` under `src/features/relay/`;
`docs/relay-queries.md:115–127`.

### 2. Make host shutdown reachable despite stuck plugin cleanup

**Proposed invariant:** host-owned connections, subscriptions, timers and new work
can be stopped even when a plugin's asynchronous cleanup never completes.

- Keep orchestration at the app composition boundary; retain per-plugin replacement
  barriers in the runtime. Do not activate a replacement alongside unfinished cleanup.
- Make cancellation of shared host resources independently reachable. Merely racing
  the first await against a timer is not enough if root disposal still waits on the
  same stuck child. Preserve persistence of already queued local intent.
- Exercise the real app/Cordis ownership arrangement with a plugin whose cleanup
  never resolves. Assert host cancellation, repeated-disposal safety, late-import
  fencing, normal cleanup and replacement behavior. A fake fiber alone is insufficient.
- Keep the trust limit explicit: asynchronous cleanup can be bounded/diagnosed;
  a synchronous infinite loop in shared JavaScript still requires restart/safe mode.

**Exit:** production-boundary tests prove host resources stop without releasing the
bad plugin; ordinary disable/update behavior and recovery remain intact.
Sources: `src/app/services.ts:26–31`, `src/plugins/manager.ts:148–154`,
`src/plugins/runtime.ts:129–155,207–222`,
`src/features/communities/service.ts:150–155`, `README.md:82–110`.

### 3. Consolidate organization and make examples trustworthy

- Correct the disposal example and generation-only remount recipe early, in a
  separate small docs/test slice. Explain scope/viewer identity versus connection
  generation; test A/B switching when both ready sessions share a generation.
- Update the ownership map and lifecycle documentation to match the fixed code.
  Keep names explicit about access loss, ordinary cancellation and cache clearing.
- Review the large channel store by responsibility, not line count. Extract only a
  coherent unit exposed by the fixes, with one state owner and fewer cross-module
  assumptions. It is acceptable to retain the file if splitting adds coordination.
- Keep mechanical extraction/import changes separate from behavioral changes.
  Prefer nearby tests and the existing helpers over a generic lifecycle framework.
- Prepare an explicit public-versus-host-only contract inventory. Do not export all
  internal service controls or duplicate their types in another hand-maintained SDK.

**Exit:** a reader can locate the owner, caller and regression test for each invariant;
organization changes preserve behavior, and examples execute through the real API.
Then stop for Wes's review before expanding product scope.
Sources: `docs/relay-queries.md:11–28,59–70`,
`src/features/relay/service.ts:48–54,94–100`,
`src/features/channels/ChannelsPage.tsx:60–65`,
`docs/foundation-review.md:87–113`.

### 4. Separately guided: external authoring and packaged capabilities

Use a real-data page and a non-GitHub panel as consumers to constrain this work;
write their acceptance cases before designing an API. Assign independent authors
explicitly so implementation is not duplicated.

- **One supported author entry point:** authoritative types plus the smallest usable
  hooks/component reuse route. Scaffold, examples and bundled representative usage
  must exercise the same supported contract. Retain one shared React runtime.
- **Compatibility:** declare preview stability, version breaking changes or explicitly
  adapt them, and test archived plugin artifacts. A rebuild instruction is not a
  compatibility guarantee.
- **Concrete platform adapter:** separate identity/community transport access from
  selection and lifetime so development broker and native paths can share behavior.
  Choose the packaged identity/login journey with Wes first; private keys stay out
  of plugin JavaScript and existing broker safeguards remain unchanged.
- **External connections:** choose a reviewed-origin policy or narrowly scoped
  host capability with Wes. Do not replace CSP with unrestricted networking.

**Exit:** independent projects build without private repository imports or copied
contract declarations; packaged real data works without the development broker.
Sources: `src/plugins/api.ts:1–25`, `crates/plugin-manager/src/main.rs:152–209`,
`src/features/communities/service.ts:70–100`, `src/features/communities/api.ts:13–44`,
`src-tauri/src/lib.rs:61–70`, `src-tauri/tauri.conf.json:29`,
`docs/plugin-architecture.md:5–15,28,56`, `docs/communities.md:56–61`.

### 5. Prove the installed-app journey before calling it release-ready

- For both independently authored, reviewed plugins: build → install disabled →
  enable → real use → A/B switching → update/remount → disable → rollback →
  failed-start recovery/safe mode. Include revoked access, unknown/rejected writes
  and stalled cleanup. No bespoke host patches for their basic supported behavior.
- Run full existing checks and a packaged-app smoke pass; record exact artifacts and
  platforms. `just scan` is not a signed/release or cross-platform validation.
- Measure repeated mount/unmount and A/B cycles, active subscriptions and aggregate
  retention with these actual consumers. Fix measured leaks or budget failures;
  defer workers/indexes/query-engine replacement until evidence warrants them.
- Before supported distribution, wire existing validation to the selected CI and
  decide signing, updates, provenance and compatibility support. Settings deliberately
  omits plugin/profile details today; changing that presentation needs design guidance.
- Announce native launches in advance with app name, purpose, open/close activity and
  input-automation needs; use isolated app data **and** a separately verified test
  identity/keyring. No live writes or real-identity access as test setup without consent.

**Exit:** publish the results and remaining limits; Wes decides whether to expand.
Sources: `README.md:18,31–63,100–110,133–134`, `docs/shell-design.md:22–24`,
`docs/foundation-review.md:60–78`.

## Guidance gates and execution rules

Planning alone was not permission to edit protected code (`AGENTS.md:7–10`). Wes's
subsequent approval covers the named revocation and teardown slices below; it does
not waive later platform/author-contract gates:

| Slice | Protected files likely to need edits | Guidance sought |
| --- | --- | --- |
| Revocation | `src/features/relay/session.ts` | Coordinate access loss across host-owned read views while preserving durable intent. |
| Teardown | `src/app/services.ts`; `src/features/communities/service.ts` if required | Independently reachable host cancellation, retaining plugin replacement barriers. |
| Platform/author contract | `src/features/communities/service.ts`, `src/plugins/api.ts`; `src/features/pages/service.ts` / `src/features/panels/service.ts` only if contracts change | Choose the supported native journey and smallest versioned author surface first. |

Other protected files (`justfile`, `src/main.tsx`, `src/app/App.tsx`,
`src/app/RecoveryScreen.tsx`) are not planned edit targets; escalate if required.

For each slice: agree behavior and owned paths → add regression → minimal fix →
`just iterate` for routine feedback plus focused tests → full `just scan` before
review → independent review of risky boundaries → report exact-state evidence.
Inspect formatting side effects before staging. Stop at unverified blockers, do not
silently absorb unrelated failures or broaden the public contract. No commit, push,
approval or merge is included in the current local review handoff.

**Not in this plan by default:** sandboxing unreviewed code, marketplace, universal
UI SDK, query DSL, new cache/state framework, arbitrary community management,
agent APIs, broad UI redesign or speculative performance rewrites.

## Planning evidence and review

This draft is based on a fresh source read of the stated worktree, its root
instructions and product/design documents. No product changes, dependency installs,
tests, native launches or live writes were performed during planning.

Pinky's background architecture review and Brain's independent challenge of
organization and sequencing were recorded on 2026-09-08. Private review artifacts
are not included in this repository.
This draft incorporates that critique: fix ownership before extracting modules,
correct examples early, avoid size-driven splits, and gate FOUNDATION edits.


## Checkpoint 1 execution — 2026-09-08

Implemented locally, uncommitted/unpushed. The protected edits are confined to
`src/features/relay/session.ts` and `src/app/services.ts`, as authorized. No
production runtime/manager, native login, network policy or external SDK changes.

- Discovery/store remains the access authority; session owns invalidation, all
  retained projections, deferred revocation notifications and stale-work fences.
  Complete roster authority is separate from optional metadata; newer live grants
  survive older discovery work. Reference visibility is a small stateless helper,
  not another membership cache. Pending signed operations survive read revocation.
- App disposal starts shared-host cancellation independently of plugin cleanup,
  joins real completion and rejects on timeout. Replacement barriers are unchanged.
- All 12 Channels UI/state/style/test files moved into `bundled/channels`; the
  composite scope/generation key is a separate behavior fix. Persisted intent remains
  scope-keyed. Lifecycle/ownership docs now match production, without claiming SDK parity.
- Hermit pins just, Node, pnpm and Rust; registry settings stay repo-local. Both Git
  and Biome exclude `.hermit/`. Manifests, lockfiles and justfile remain unchanged.
- Final `iterate` then `scan`: 21 Node tests, 148 Vitest tests, 8 Rust plugin-manager
  tests; formatting/type/frontend build/Clippy/native test targets passed. Native
  test targets currently contain zero cases. 104 non-fatal Biome warnings remain;
  no broad warning cleanup was included. Source hashes were unchanged by both gates.
- Independent review closed the reproduced gaps. Selected isolated mutation checks
  fail on removal of seven relay boundaries and seven teardown/remount boundaries;
  restored controls pass. These are regression evidence, not exhaustive proof.

Pinky’s self-review checkpoint for this bounded slice: **minimalness 9/10, elegance
9/10, correctness 9/10**. The added coordination follows reproduced ownership/race
failures rather than a speculative framework. Ratings are engineering judgment;
remaining browser/native/product gates prevent any release-readiness claim.

Review paths, exact validation scope and the **not yet executed** manual checklist:
[hardening-validation.md](hardening-validation.md). Pause here for Wes’s review;
steps 4–5 still require separate product guidance.

## Approved local-review follow-up: public development identity pin

Wes authorized the narrow development-broker portability fix on 2026-09-08 after
his live startup hit the prototype's hard-coded viewer restriction. Implemented explicit
`BUZZ_DEV_VIEWER` (public hex/npub) via Vite env loading, retaining pre-credential
validation and identity matching. Live remains opt-in; no native login, new
credential source, or network policy change. Full scan and independent boundary
review pass; actual native live success remains a manual gate. See the
[follow-up validation](hardening-validation.md#local-review-follow-up-development-identity-portability).

Handoff invariant: before advertising a run command as usable by another developer,
trace its real identity/configuration path and identify single-person assumptions.
Compilation and fixtures do not establish portable live onboarding.

## Local-review correction: test the consuming UI lifecycle

The hardening rewrite made discovery async without preserving its public void
runtime contract. Existing service tests and independent race probes missed the
React effect caller. The resulting Promise-as-cleanup failure reproduced through
the actual app in Chromium and WebKit. Only the two store wrappers changed in the
repair; new production hook/renderer and return-contract tests protect the boundary.
See [the current validation](hardening-validation.md#local-review-follow-up-react-lifecycle-regression).

For changes to service lifecycle/return behavior, trace all returned-value consumers
and mount the actual React hook under StrictMode and ordinary unmount. A TypeScript
void declaration does not discard a Promise. Before another user-visible handoff,
exercise the ordinary app route (select, interact, dialog close, navigate, reload)
with isolated fixture data; do not substitute additional unit/mutation counts for
that workflow. Independent review must cover consumers, not only the same mechanism.

## Owner confirmation and remaining work — 2026-09-08 22:48 UTC

Wes confirmed “ok that fixed the issue” after the native interaction-fix handoff
at the time recorded in this heading. Record this as owner confirmation of the reported freeze,
not evidence that every native workflow or manual checklist item passed.

- **Implemented:** steps 0–3 (toolchain/baseline, session revocation, host shutdown,
  Channels ownership and examples), plus explicit public development identity and
  the React lifecycle repair. Current full scan and browser fixtures pass.
- **Remaining checkpoint acceptance:** community switch/reconnect with drafts and
  view state; controlled read-revocation and pending-delivery/restart workflows;
  plugin disable/update/cleanup/recovery through the UI. Review the local diff and
  decide when to commit; nothing is committed or pushed yet.
- **Separate next milestone (steps 4–5):** supported external author entry point,
  per-user native identity/session path, reviewed external-network policy, then
  independently authored page and non-GitHub panel exercised as packaged plugins.
  Signing/distribution/CI and cross-platform validation remain later gates.

Recommendation: finish current checkpoint's acceptance journeys before expanding
product scope. Owner confirmation of one fix does not restore a blanket 10/10 or
release-readiness claim.


## Acceptance follow-up — 2026-09-08 23:07 UTC

The isolated actual-app Chromium/WebKit journeys now cover community drafts,
selection/panel isolation, stream reconnect and failed-session UI retry, signed
revocation/held late reads/regrant, complete roster omission with failed metadata,
and interrupted signed send across reload/revocation followed by exact-event retry.
Independent plugin checks distinguish real browser storage from fixture external
storage; native CLI/filesystem/IPC acceptance remains explicitly open.

Acceptance found a pre-existing reading-position bug: React's scroll handler read
Virtua's previous metrics. A single handler now reads current DOM metrics; both
engines restore exact positions across repeated community/channel switches.
Details and caveats are in [current acceptance](hardening-validation.md#checkpoint-acceptance--2026-09-08-isolated-browsers).

The complete local diff was reviewed without staging/committing. No blanket
readiness claim; native/package/cross-platform gates remain. Wes separately asked
about typing a community URL; the current fixed-list limitation was explained and
a scoped follow-up proposed. Do not implement arbitrary routing or edit protected
community ownership without that next approval. Steps 4–5 remain guided work.


## Final local integration — 2026-09-08 23:10 UTC

The scroll repair now includes 18 production-handler/cleanup boundary regressions;
all eight selected independent mutations are detected. After one formatting-only
line wrap, the full pinned scan passes: **21 Node, 194 Vitest (29 files), 8 Rust
integration tests**, types/build/format/Clippy; 105 non-fatal Biome warnings. Native
test targets still contain zero cases. Complete content/symlink/index snapshots
match before and after the passing run; only handoff docs changed afterward.
See [exact final gate](hardening-validation.md#final-integrated-regression-and-gate--2026-09-08-2310-utc).

The browser/fixture portion of the agreed acceptance pass and local diff review
are complete, including the acceptance-found pre-existing scroll repair. This does
not close actual native install/update/IPC/on-disk recovery/process restart, the
full real-identity/Keychain/relay matrix, packaging/signing, CI/cross-platform or
external-author milestones. Those require separate scope/isolation agreement;
manual community URL entry also remains proposed, not approved or implemented.
All changes remain local, uncommitted and unpushed for Wes's review.

Self-review of the scroll slice: minimalness **9/10**, elegance **9/10**, correctness
**9/10**. One existing decision boundary now samples current geometry; no new owner,
scheduling workaround or scope expansion. These are bounded engineering judgments
supported by renderer, regression and mutation evidence, not a release rating.


## Authorized follow-up — 2026-09-08 23:16 UTC

Wes's approval at the time recorded in this heading authorizes committing/pushing
the checkpoint, followed by typed relay URL entry
**instead of a dropdown**. Checkpoint commit `deb1d3101f8909e7d506d354dbe752fc911e1590`
was pushed to relay branch `foundation-hardening`; the remote ref matched. Pinky
is author and Brain co-author for material implementation. The staged tree matched
the verified handoff, including modes, symlinks and deletions; no new gate run was
needed merely to reattribute identical content.

Pinky owns the URL implementation/full validation; Brain independently reviews the
routing/security boundary and mutation sensitivity. The authorized FOUNDATION edit
is `src/features/communities/service.ts`: canonical membership selection/hydration,
legacy compatibility and arbitrary destination routing. No lifetime rewrite, SDK,
native identity adapter or CSP expansion. A shared secure-origin parser and local
same-origin broker registration keep arbitrary destinations explicitly scoped.
The former two-session maximum no longer applies; retained sessions still last
until disposal rather than silently evicting active delivery contexts.

See [community behavior and trust limits](../communities.md). Tests stay with their
current owners/runners; Wes's question about test organization was answered with a
recommendation for separate cleanup, not folded into this feature.


Typed-URL validation is complete: **21 Node, 228 Vitest / 31 files, 8 Rust
integration**, types/build/format/Clippy; both browser engines pass the URL journey
and earlier access/delivery acceptance. Brain's independent review found no
remaining blocker; all 16 selected defects are detected. See
[exact gate and evidence caveats](hardening-validation.md#typed-relay-urls--2026-09-08-2327-utc).
URL edits remain uncommitted; no second push implied. Test-organization cleanup is
an endorsed separate follow-up, not included in this feature. Minimalness 9/10,
elegance 9/10, correctness 9/10 for this bounded development slice; these are
self-review judgments, not release ratings.


## Browser regression follow-up — 2026-09-08

Wes's approval on 2026-09-08 authorizes the repeatable browser-testing slice and
local commits, followed by
his UI/functionality pass. The previously verified URL slice was committed as
`a85fda6` after exact staged-byte comparison with its passing gate. No second push.

The browser slice changes only tests, development dependency/commands and docs;
no production behavior or FOUNDATION file edits. Pinky owns integration and full
validation; Brain owns isolated review and defect mutations. See
[browser testing](../browser-testing.md) for executable commands, isolation, assertions
and the existing cold-geometry/oversized-cache offset-only limitation. Timing and
heap measurements are diagnostic until calibrated on a stable runner. Other
root-test moves/runner conversions remain a separate cleanup.


Final gate: 21 Node, 228 Vitest, 8 Rust integration, 4 browser tests, plus all
existing scan checks; two extra browser repetitions pass 8/8. Brain's 7 selected
regressions fail in both engines, with 4/4 restored controls. See
[the validation record](hardening-validation.md#checked-in-browser-regression-gate--2026-09-09-0000-utc)
for exact source attribution and known warnings. Final self-review: minimalness
9/10, elegance 9/10, correctness 9/10 for this bounded test slice, not release scores.
