# Session sharing validation

Behavior and limitations live in [Sharing a live session](sharing.md) and
[Me and sessions](README.md). This record separates checked snapshots from
outstanding acceptance; earlier feedback-round counts are not aggregate results.

## Checked snapshots

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

## Selected-channel footer correction

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

## Discriminating regressions

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

## Browser coverage and remaining gates

Two cases per engine were added: same-ID conversion and combined lifetime/settings.
No browser cases were removed. Existing journeys retain routing/history, local
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
