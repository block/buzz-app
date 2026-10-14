# Session sharing validation

Behavior and limitations live in [Sharing a live session](sharing.md) and
[Me and sessions](README.md). This record separates checked snapshots from
outstanding acceptance; earlier feedback-round counts are not aggregate results.

## Review repairs (2026-10-14)

The author requested repair of Wes's review comments on PR #1070. The independent
sharing branch merged main `71e2c229e` cleanly in `6076c3f6d`, preserving the
published commits. This pass repairs the two reported blockers and two should-fix
comments; the Public/Me recipient and agent-reply policy remains a product question.

- Retry renders its original destination snapshot as **Submitted audience**, not
  a changed current roster. The mounted departure/join/reopen and oversized-audience
  assertions failed before the repair; exact recipients and link receipts stay intact.
- Messages owns conversion outside the type-dependent heading. A StrictMode-mounted
  actual `ChannelsPage` test holds the real details capability's return after signed
  stream metadata is accepted. Before repair, the form disappears while held; after
  repair it remains pending and completes once, with the success announcement.
- A real-browser journey additionally found replacement-composer autofocus stealing
  the modal's return focus in both engines. The workspace now suppresses that default
  focus only on an existing conversation's session-to-channel transition. Shared
  focus behavior is unchanged. Cancel returns to Share; completion returns to the
  replacement Channel actions button. Retired-visit completion remains fenced.
- Header/row/footer and already-open conversion controls observe begin/finish in the
  existing share-attempt owner. Mounted tests begin and finish an attempt from another
  entry point and verify disabled controls, no write, then recovery. No new reads,
  timer, polling, durable journal or relay permission behavior.
- History warnings now say unrecorded people appear under Other access. No eviction
  or automatic repair was added; the existing full/malformed-state limitation is
  documented, and the previous record is retained.

Checked production: `6076c3f6d` plus the review-repair diff (final commit in PR).
Pinned Hermit commands ran the complete affected files:

| Check | Result | Local time |
| --- | --- | --- |
| Eleven Vitest owner files | 189 tests | 17.11s wall; 26.64s summed test execution |
| Complete Me/sharing browser files, Chromium + WebKit | 18 cases | 32.0s wall; 51.6s summed case time; two workers, no retries |

The previous eight owner files are joined by `share-attempt`, the existing shallow
`ChannelsPage` boundary tests, and a new real-React `ChannelsPage.conversion` file.
Slowest file: SessionShare, 14.07s. Slowest browser case: WebKit Share
reachability/recovery, 5.4s. These are local fixture measurements, not hosted CI.
The browser total increases from 16 to 18: one new Messages conversion focus
journey per engine, justified by native modal-to-replacement-header focus. No case
was removed; departure/join/retry and held completion matrices remain at the mounted
layer. Existing screenshots cover both themes, narrow/intermediate/wide widths and
enlarged text; pending light/intermediate and dark/narrow captures were inspected.

Main advanced again during validation. The clean merge `3dd9d56cc` includes main
`01830334f` (notification reveal and nested-reply test fixes). The complete 18-case
browser files passed again in 32.6s after that merge. The real mounted Messages
conversion file and incoming `use-message-reveal` file also passed together:
16 tests, 5.19s wall / 1.46s execution. A final TypeScript check caught a test-only
Testing Library option copied from Playwright (`exact`); removing that unsupported
option preserves exact string-name matching. Normal push hooks check final types
and related tests; no compiler target or assertion was weakened.

Independent read-only repair review found no blocker and assessed the slice 9/10.
The configured desktop and original sharing/lifetime worktrees remain untouched.
No live-account grants, native launch/build, routine full scan or PR merge occurred.
Renewed human confirmation, packaged/native and live-relay acceptance, current hosted
CI and Wes/code-owner approval remain open. The old review is not self-dismissed,
and no completed-review attestation is added.

## Independent sharing PR and pending-footer correction (2026-10-14)

PR #1070 is rebased from the published sharing head `ec2a44b81` onto main
`f442ed0a5`. Lifetime/settings and optional naming remain separate in PR #1079;
sharing and conversion do not depend on them. The main-relative diff has no
lifetime editor, creation/TTL host changes, settings form, or naming implementation.
Conversion retains only the required session-menu trigger/ref wiring and its focus
regression. The running sharing checkout remains unchanged.

The initial pending share no longer inserts a disabled **Start over** action.
One pending-action state retains the original Share/Retry label and recovery
button set, without changing operation receipts or grant/link admission. Its mounted
regression failed before repair; the existing held-readback browser journey also
failed in Chromium and WebKit before repair. No new browser case was needed.
The repaired journey compares exact footer geometry before/after submission and
captures pending light/dark 390/950/1280px layouts. The first after-run caught a
fixture mistake: the new narrow capture left the sidebar collapsed before an
existing desktop row assertion. Restoring the original viewport fixes the fixture,
without changing product behavior, assertions, timeouts, or retries.

Main's new channel labels remain outside conversion intent. The explicit conversion
draft omits labels, so no label tags are sent; independent relabeling cannot be
overwritten or strand uncertain recovery. Read-only review caught the initial
label-sensitive recovery error. Both mounted/remounted uncertainty regressions
failed before this repair and passed afterward. Existing name/visibility/TTL
conflict checks and readback-only recovery remain.

Checked production tree: `732b855b8` plus the pending-action and label-neutral
conversion changes (final commit/check links are recorded in the PR).

| Check | Result | Local time |
| --- | --- | --- |
| Eight complete affected Vitest owner files | 176 tests | 14.81s wall; 22.47s summed test execution |
| Complete Me/sharing files, Chromium + WebKit | 16 cases | 31.2s wall; 48.4s summed case time; two workers, no retries |
| Changed-file Biome | Passed | Pinned tools |

Vitest files: `SessionShare`, `ConvertSession`, `share`, `share-history`,
`SessionsPage.loading`, `ChannelSidebar`, `channel-details`, and channel-member
`members`. Browser files: `me-polish.spec.mjs` and `session-sharing.spec.mjs`,
using `pnpm test:browser <files> --no-deps --project=chromium --project=webkit`.
Commands use pinned Hermit tools. The slowest owner file was `SessionShare`
(about 13s); the slowest browser case was WebKit Share reachability/recovery (5.5s).
Read-only follow-up closed the concrete label-recovery finding; source verification
rejected a mistaken first-button focus claim because the existing row button
precedes the indicator. The 9/10 review bar is met for the changed integration.
Commands use no hook bypasses. Screenshots were inspected. These tests use
isolated fixture identities and do not touch configured accounts.

The previous combined stack had 18 browser cases in these files. Its one
lifetime/settings case per engine remains in #1079, not deleted from that work.
All sharing/conversion cases and their assertions remain here; same-ID conversion
is the one added case per engine relative to main. Failure matrices remain in
mounted/service tests. No routine full scan, live write, app restart or merge.
Human confirmation of the independently rebased build, packaged/native and live
relay acceptance, current hosted CI and required review remain separate gates.
A concurrent hosted review of `ec2a44b81` reported frozen-audience display drift
and Messages-header conversion lifetime/focus issues. They are not repaired or
closed by this bounded unstack/footer update; the PR remains draft with those
findings open. Its other permission-entry and copy comments also remain for triage.
The local follow-up above is a changed-integration review, not whole-feature approval.

## Historical combined-stack evidence

The following results include the earlier combined lifetime/settings work where
noted. They are not validation of the independent PR snapshot above.

### Checked snapshots

Rebase onto main `49ae64bb0` completed without conflicts. Feature snapshot
`c98fc1fce` passed the following focused integration checks:

| Check | Result | Local time |
| --- | --- | --- |
| Client/host and overlapping-owner Vitest | 509 tests, 22 files | 15.33s wall; 45.25s summed execution |
| Native channel-write guards | 11 tests | 15.17s build; 0.05s execution |
| Shared design tests | 161 tests, 25 files | 3.56s wall; 4.64s execution |
| Design viewer builds | `design:build` passed | Includes design typecheck |
| Sharing, Me, header and sidebar journeys | 66 Chromium/WebKit cases | 2.5m; two workers, no retries |

Commands used pinned `bin/` tools: `pnpm exec vitest run <owner files>`,
`cargo test -p buzz-foundation relay::channel_writes --lib --locked`,
`pnpm design:test`, `pnpm design:build`, and `pnpm test:browser` with the complete
`session-sharing`, `me-polish`, `channel-header-menu` and `navigation-sidebar`
files in both engines. Frozen dependency refresh applied main's Base UI patch
without lockfile changes.

The subsequent menu-ref repair at `a6c87889a` passed 48 affected RTL tests in
three complete files (14.35s wall; 14.63s execution) and all ten Me journeys
across both engines (31.4s). Mandatory push hooks passed client types/related
Vitest, design types/guards, locked workspace all-target Clippy with warnings
denied, and organization policy. Commit hooks passed applicable formatting,
icon checks and machine secret scanning; commits carry DCO and agent attribution.
The diary was condensed from 1,020 to fewer than 100 lines without deleting tests.
Later agent-row feedback passed 40 owner tests in four complete files (14.32s wall;
13.83s execution) and 18 Chromium/WebKit cases (44.6s). The initial browser run
passed 16/18: its old 17-member fallback expectation needed to exclude two agents
now rendered individually, leaving 15. The mounted solo-agent case failed before
repair; channel-only/direct-history overlap remains covered. No cases were added
or removed. Hosted checks remain a separate gate reported in the pull request.

### Selected-channel footer correction

On the stacked `ae5796e94` tree plus this correction, 54 owner tests in five files
passed (14.65s wall; 16.36s execution), then all 18 Chromium/WebKit Me/sharing
journeys passed (45.8s, two workers, no retries). The existing Me case demonstrated
52px action-row separation before the compact **Share** label and trailing group;
its 390px/2× extension demonstrated 104px separation before non-wrapping grouping.
Native Tab then exposed nested overflow clipping; bounded group scrolling and a
physically contained focus-reveal handler passed the unchanged center hit tests.
Hover/focus tooltip, tooltip Escape, exact held grant/link ordering, both themes
and default/enlarged layouts passed. No cases added/removed or permissions changed.
Normal-width actions stay on one row; narrow enlarged controls scroll as one group.
Screenshots were inspected; human/native/hosted acceptance remains separate.

### Discriminating regressions

Mounted React uses real collaborating owners and held external operations, not
mocked hooks. The following failures were demonstrated before repair and passed
afterward:

- Failed conversion read with an uncertain attempt lacked Reload; pending Public
  intent also displayed Private before reload. Reload now preserves exact intent,
  and Check status reconciles without signing or publishing again.
- A validated 101-key destination was rejected before freezing. Retry could adopt
  changed membership. The attempt now freezes before the existing combined cap;
  it sends nothing until explicit Start over captures different intent.
- Draft-settings read failure still showed Loading. Error/Retry now replaces it;
  held Retry proves pending state, recovery and local draft persistence.
- Row Share omitted its captured visit. Real SessionSections with held signing
  published after that visit retired. Forwarding the signal prevents publication
  and late completion while the sidebar survives navigation.
- A lifetime save after status reconciliation used stale eligibility following
  external conversion. Fresh actual-base validation prevents the extra signature.
- Session actions overwrote Base UI's trigger ref. Keyboard/focus alone did not
  catch it; the mounted menu's external `aria-labelledby` relationship did.
  The existing render-element pattern preserves internal and return-focus refs.

Wes derivation, boundary/lifecycle and test-honesty reviews and independent Crack
Catcher reviews closed their concrete findings. Final bounded integration/ref
follow-ups scored 9/10 or higher with no remaining finding. Exhausted delegates
were not treated as approvals. These reviews do not certify shipping acceptance.

### Historical browser coverage and remaining gates

The historical combined feature added two cases per engine: same-ID conversion
and combined lifetime/settings. The independent split is mapped above. Existing journeys retain routing/history, local
storage reload, exact link recovery, portalled search, scrolling/hit testing,
keyboard dismissal and focus restoration. Lower-layer tests own failure matrices.
Light/dark, 390/950/1280px and enlarged-text captures were inspected; shared
specimens alone are not host-integration acceptance.

The user approved the earlier running interface. Human confirmation of the rebased
build/ref repair, packaged/native GUI quit/relaunch, real-relay ACL/Public history,
cross-account discovery/no-wake behavior, hosted CI and required approvals remain
outstanding. Native guards prove command enforcement, not packaged GUI behavior.
Narrow enlarged-text footer edge/focus clipping remains despite Tab/center
reachability. Main's opaque modal fill supersedes earlier translucent dialog
captures. No full scan, live-account write, app restart or merge was performed.

Device-local history remains display-only, with no cross-device sync or backfill.
Naming/named links, direct DM handoff, read-only access roles and synced encrypted
provenance remain deferred. Local logs and screenshots are preserved outside git
under `/tmp/session-sharing-pr-20261014/` and the earlier focused-check directories;
raw logs, session transcripts and screenshots are not committed.
