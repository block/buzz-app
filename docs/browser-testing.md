# Browser scrolling regression gate

`pnpm test` and therefore `just scan` now run the checked-in Chromium and WebKit
journeys in `tests/browser/`. `just iterate` remains the fast, browser-free loop.
There is no repository-hosted CI configuration yet: this is an executable local
and CI-ready gate, not a claim that the relay runs it on every push.
Owner-specific tests are colocated in `src/` and `dev/`; separate manual diagnostic
pages live in `tests/fixtures/`. See [test organization and fixture URLs](contributing.md#test-organization).

## Run

```sh
source bin/activate-hermit
bin/pnpm install --frozen-lockfile
bin/pnpm test:browser:install # once per Playwright version / runner cache
bin/pnpm test:browser         # both engines; serial measurements, two functional workers, no retries
bin/just scan                # includes browser tests and all existing gates
```

Playwright is pinned to 1.60.0; the browser installer downloads its matching
Chromium and WebKit revisions. Do not borrow another checkout's node_modules or
silently skip an engine when its executable is missing. Linux runners also need
Playwright's documented system libraries provisioned by their administrator.
The initial verified runner is Apple Silicon macOS, not a cross-platform result.
No native application or interactive browser is opened.

For repeatability and diagnostic baselines:

```sh
# Repeat both engines' measurements without concurrent browser load:
bin/pnpm test:browser --project '*-measurements' --no-deps --workers=1 --repeat-each=3
bin/pnpm test:browser --project chromium-measurements --grep 'cursor paging' --no-deps
# Focused functional iteration skips the measurement phase:
bin/pnpm test:browser tests/browser/layout.spec.mjs --no-deps
# Complete diagnostic sweep: independent failures, serial measurements.
# Add --repeat-each=3 here to repeat every case in both engines.
bin/pnpm test:browser --no-deps --workers=1
```

The default gate runs `channel-opening.spec.mjs` and `scroll.spec.mjs` first,
one browser/worker at a time, through the `chromium-measurements` →
`webkit-measurements` dependency chain. Only then may functional journeys run
with two workers. This preserves timing/heap samples without unrelated browser
load; it does not change assertion budgets or add retries.

This is deliberately fail-fast across phases: a Chromium measurement failure
skips WebKit measurements and all functional journeys; a WebKit measurement
failure skips functional journeys. The gate stays red, but reports fewer
independent failures. Use the serial diagnostic sweep above to run all projects
regardless of earlier failures. Keep `--workers=1` when using `--no-deps` across
measurement projects, otherwise the engines can contend with each other.
Focused functional runs use `--no-deps` to avoid measurement dependencies.

Playwright 1.60 applies CLI repeat and test filters only to top-level projects,
not their dependencies. Bare `--repeat-each=3` therefore does **not** repeat the
measurements in the default gate. The explicit measurement command above uses
`--no-deps` so all selected measurements repeat, with `--workers=1` to retain
isolation and one invocation to preserve both engines' evidence.

Compiled frontend assets are worker-scoped, split by `developmentReact` and
`pluginFixtures`, and removed when that worker ends. They are never reused across
invocations. Every test still gets a fresh preview server/port, ephemeral signing
keys, signed histories, relay state and browser context/storage. Evidence records
the worker and its build time; worker restarts rebuild rather than reuse stale assets.

Results go to ignored `test-results/browser/`: each test writes `evidence.json`
with runtime versions, HEAD/dirty status, request ledger, runtime errors and
measurements. Failure screenshots and traces are retained too. The next invocation
replaces that output; copy artifacts before a rerun if you need to compare them.
A dirty-status listing is not a content hash; tie release claims to a separately
verified clean commit or source manifest.

## What fails the gate

Actual-app scrolling and layout journeys run in each engine:

- Real wheel scrolling, channel/community returns and scoped drafts. The
  cache-eligible history must restore the same message's text within **4px** of
  its previous viewport-relative Y. Reload must restore that same message anchor.
- Signed live appends must be received. At bottom they are followed; while
  reading above bottom they must not steal the reading anchor. Signed live edits
  must also follow bottom through row growth/shrinkage without another append;
  edits below the reader and to mounted rows wholly above the viewport must
  preserve the visible message. Non-paging fixtures use taller messages and
  explicitly verify the reading position is outside the older-page prefetch zone.
- Thirty-one **unique, serial cursor requests**, initiated by real wheel input
  and continued while near the top, grow the history from 20 to **640 mixed-height
  messages**. Each held HTTP completion is released after sampling
  the visible message. That message's text must retain its viewport-relative Y,
  and returned older IDs must actually enter the rendered window. Date separators
  are not part of the message anchor: their location changes on same-day prepend.
- Repeated large-history returns preserve the visible message and non-follow intent.
  A complete scroll traversal must find **all 640 original IDs plus the live
  append**, without fetching them again.
- Throughout the large-history journey, at most **100 message rows** and fewer
  than **1,800 total DOM elements** may be mounted. These generous structural
  ceilings catch rendering the entire history; they are not frame-rate or heap
  budgets. Review deliberate UI expansion against them rather than raising limits
  automatically.
- Unexpected network routes, external HTTP/WebSocket attempts, console errors and
  page errors fail. The exact existing WebKit `ResizeObserver loop completed with
  undelivered notifications.` error is recorded as a known exception, not suppressed
  in the app. Chromium gets no such exception.

The runner builds the actual `index.html`/`main.tsx` in production mode, serves it
on an ephemeral loopback port, and supplies signed fixture broker responses and
real localhost SSE. It does not replace React, Virtua, app services, event
verification, browser storage or production scroll handlers. Only public fixture
memberships are seeded; reading state is established through UI interactions.
Vite config/env files are disabled and all fixture keys are ephemeral. Layout
journeys substitute the broker. `live.spec.mjs` instead injects that ephemeral
identity into the production broker and models only upstream WS/HTTP policy; it
never reads Keychain credentials. No upstream relay writes, native IPC or packaged
sign-in are tested.

The live journeys require actual production AUTH/channel REQs → broker POST/SSE →
session → mounted UI delivery, selective retry during/after an HTTP pause, and
finite catch-up of a signed missed message. Reconnect preserves older pages,
cursor, reading anchor and draft. An empty paused roster must expose ordinary Live
retry and recover without replacing unchanged healthy globals. Assertions use
zero test retries; expected modeled quota console errors are explicitly recorded.
These policy fixtures establish client behavior, not deployed relay incident cause
or attended live-account acceptance.

## Channel-opening performance

`channel-opening.spec.mjs` uses the actual app/session and production broker with
an offline upstream: 128 DMs and 1,001 uncached participants. Profile responses
stay held while an unprepared channel opens. This checks the **actual sidebar
label caller**, not just the reader's priority flag. Cached returns then require
no new head request and less than **100ms** from a browser-clock button click to
visible correct-channel rows across a paint opportunity. This is a controlled
regression budget, not a universal device/relay SLA or hardware input measurement.

Run this focused journey when changing startup/sidebar scheduling:

```sh
bin/pnpm test:browser tests/browser/channel-opening.spec.mjs --project '*-measurements' --no-deps --workers=1
```

The cold assertion is independence from held optional work, not a fixed live
network budget. Live diagnostics should additionally report reader queue, broker
admission and upstream time; retain cold/warm cache state and exact source state.
The separate `channel-opening.test.ts` exercises catch-up ownership and terminal
retry states through the production session. A held-response reproducer establishes
a failure mechanism; it does not on its own identify a live incident's cause.

## DM label recovery

`dm-labels.spec.mjs` builds the actual page and uses the production broker with
signed, ephemeral fixture profiles. The real **Refresh channels** control reads a
complete roster omitting a channel. Without remounting the page or opening the DM
first, its sidebar must reacquire names after the session's safety purge. A hidden
channel disappearing while the initial profile fetch is held must cancel that read
and issue a fresh one; an already-loaded name must clear and then recover. Finally,
opening the DM checks the shared label in the conversation title.

This guards full-roster page-to-hook wiring, not just the hook in isolation. The
hidden-channel cold case must fail if the page filters the roster before passing
it to the hook. The six colocated hook/session cases also cover archived channels,
stale replies, and empty/failed profile results without retries on ordinary message
traffic. The existing channel-opening journey keeps optional names behind reading.

These tests model roster removal and explicitly refresh: they do **not** establish
which event or reconnect triggers deployed deletion catch-up, or require the
separate proposed relay notification patch. They run in both engines under the
normal `pnpm test` / `just scan` gate, which is local/CI-ready but not relay-enforced.

## Measurements, not timing guarantees

Evidence records requestAnimationFrame interval p95/max, supported long-task
observations, mounted DOM peaks, five channel-switch automation round trips, and
Chromium-only heap samples after GC at equivalent warm states. Unsupported WebKit
heap/long-task APIs are explicitly null/unsupported, not zero-cost claims.
Frame samples span the instrumented journey, including assertion waits; they are
not compositor FPS. Automation round trips are not pure input-to-paint latency.
GC and instrumentation affect the measurements themselves.

Collect repeated baselines on a stable, otherwise idle runner with the same OS,
engine version, viewport and build. Compare distributions before choosing timing
or heap thresholds; do not use these first samples as a universal 60 FPS promise.
The existing 2,400-row data-path test still separately guards synchronous send
under 50ms and deterministic fold/notification counts.

## Reading-position contract

View intent stores `{offset,bottom,anchor?:{id,y}}`, partitioned by community/viewer
and channel. Cold or oversized geometry uses the saved message ID and its row Y
with Virtua's index-based scrolling. Old offset-only records and anchors no longer
in the retained window fall back to the saved offset; this may clamp and cannot
promise the same message. No extra history is loaded just to recover an anchor.
Measured geometry stays in memory, with the unchanged three-entry / 256KiB
signature limits in `src/features/messages/geometry.ts`.

Panel opening/closing and viewport resizing preserve bottom intent or the visible
reading anchor. A new input gesture supersedes a queued restoration. The layout
journey also checks separate cards, independent panel scrolling, window-centered
tabs, community-dialog focus, and widths down to 390px.

These checks do not persist measured geometry or guarantee smoothness. A live edit
to a partly clipped, still-visible row can move the following visible messages:
Virtua's native stationary/upward-scroll compensation applies to wholly offscreen
rows, not that clipped row. This remains a known reading-position limitation,
not a passing guarantee of the above-viewport edit test. Asynchronous
media/profile-only reflow, touch, native WebViews and long-running memory soak tests
remain outside these journeys.

`initial-position.spec.mjs` also runs development React's StrictMode checks over
cold/warm sidebar entry, fitting and overflowing short histories, tall messages,
saved-bottom reloads and deliberate reading-anchor reloads. It measures the bottom
gap before any wheel correction; helpers must not scroll the test into passing.
Reading positions intentionally survive restarts. These startup controls do not
justify resetting legacy reading state or establish the cause of a reported
position without examining that state.

## History loading and live status

The history-loading journeys retain the production broker's HTTP admission. They
check that ordinary wheel paging begins before the top, and that a saved top
anchor can resume paging from a boundary gesture even when the DOM cannot scroll
farther. Restoration alone does not fetch history. A quota-failed page retains a
manual retry without repeated wheel gestures resubmitting it. These are workflow
controls, not latency guarantees under arbitrary scroll speed or relay load.

Live-status checks keep routine connecting/pending progress in Conversation
options → Diagnostics, with no warning-height flash. Bounded automatic quota
recovery also stays there until fresh EOSE confirms recovery. Exhausted retries,
unsupported quota pauses, other errors, limited coverage and deferred/failed
rosters retain the visible warning and Retry. Held-EOSE controls span automatic
and manual retries through the production broker; a sent REQ is not recovery.


## Shared conversation component reuse

`messages.spec.mjs` runs a second source consumer (`tests/fixtures/messages.tsx`)
against real React StrictMode, shared thread reader and durable outbox. It deliberately
retargets ordinary component props without caller React keys. Chromium/WebKit cover
automatic multi-page loading and bottom placement, preserving scroll through a live
reply, thread/channel/scope draft isolation, and a rejected reply retried with the
same signed event and deduplicated echo. The fixture uses ephemeral keys and local
transport only, without developer environment files, native windows or live relay.
It is not a production-broker or long-thread newest-tail test.

## Composer completion regressions

`typeahead.spec.mjs` mounts the real Composer and bundled Emoji/Mentions providers
with ephemeral signed session fixtures. It covers exact namesake recipient tags,
channel/thread isolation, middle-of-draft replacement, IME/Escape/selection, late
publications and query ABA, plugin/session revocation, stable-ID reorder, length
rejection, live catalog/member changes, unrelated previews, delayed multi-word
profiles, keyboard recovery and disabled/read-only DOM checks. The controlled
provider fixture exercises the public publication contract without changing the
host's acceptance machinery. `completion-layout.spec.mjs` uses the compiled app and
actual Channels layout at 1280×832, 800×600, 480×400 and 390×844, including hit testing
and unforced clicks. The thread case mounts the actual ThreadPanel beside another
composer. Existing emoji/mention/edit/thread journeys remain in the gate.

These are Chromium/WebKit browser results, not attended live-account, screen-reader,
software-keyboard or native-packaged acceptance. Those require separate checking.
