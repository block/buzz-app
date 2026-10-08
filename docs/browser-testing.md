# Browser scrolling regression gate

`pnpm test` and therefore `just scan` now run the checked-in Chromium and WebKit
journeys in `tests/browser/`. `just iterate` remains the fast, browser-free loop.
[GitHub Actions](../.github/workflows/ci.yml) runs these gates on PRs and main
pushes: an isolated serial measurement job runs alongside twelve functional jobs
(six file-level shards per engine, two workers per runner). Both engines remain
mandatory for the [CI-selected coverage](#ci-coverage-and-local-only-webkit-checks);
`CI required` fails if any lane or shard fails, is cancelled, or is skipped.
Owner-specific tests are colocated in `src/`, `browser-host/` and `scripts/`; separate manual diagnostic
pages live in `tests/fixtures/`. See [test organization and fixture URLs](contributing.md#test-organization).

## Run

```sh
source bin/activate-hermit
bin/pnpm install --frozen-lockfile
bin/pnpm test:browser:install # once per Playwright version / runner cache
bin/pnpm test:browser         # both engines; serial measurements, two functional workers, no retries
bin/just scan                # includes browser tests and all existing gates
```

Playwright is pinned to 1.63.0; the browser installer downloads its matching
Chromium and WebKit revisions. Do not borrow another checkout's node_modules or
silently skip an engine when its executable is missing. Linux runners also need
Playwright's documented system libraries provisioned by their administrator.
The initial verified runner is Apple Silicon macOS, not a cross-platform result.
No native application or interactive browser is opened.

The 1.63.0 pin replaces 1.60.0 after an isolated Ubuntu 24.04 ARM64 replay showed
WebKit 2287 stranding the tail of an open Fetch stream until another write.
Stock WebKit 2359 consumed it while the server stayed idle, with byte streams
still enabled, both with and without Playwright interception. The unchanged
`sidebar-unread.spec.mjs` then passed all ten Chromium/WebKit cases; its two
previously failing assertions and timeouts are unchanged. The full scroll file
passed five of six cases: the documented Linux WebKit wheel-edge limitation
remains. This is bounded test-browser evidence, not a fix for older Safari clients
or proof of hosted CI success. No browser feature overrides or CI exclusions were
added by the pin update; existing local-only cases below remain unchanged.

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

The default local gate runs `channel-opening.spec.mjs` and `scroll.spec.mjs` first,
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
invocations. Every built-app test still gets a fresh preview server/port, ephemeral
signing keys, signed histories, relay state and browser context/storage. Evidence records
the worker and its build time, plus history counts and signing time; worker
restarts rebuild rather than reuse stale assets.

Declare `historyCounts` with `test.use` for built-app tests that do not need large
histories, for example `{ alpha: 1, beta: 0 }`. Counts apply per community. Keep
pagination, anchor and measurement datasets unchanged unless their behavior is
revalidated at the new size. The legacy large default remains for unaudited cases;
new tests should explicitly choose their data rather than inherit it accidentally.

Source-only diagnostic pages can import `test` and `expect` from
`source-fixture.mjs` and navigate to `/tests/fixtures/example.html`. That fixture
shares a stateless Vite server and its isolated optimizer cache per worker, with
fresh browser contexts/storage for every test. Do not use it for custom mutable
server middleware or a different Vite configuration. The existing `vite-server.mjs`
helper keeps independently configured servers' caches isolated.

Results go to ignored `test-results/browser/`: each built-app test writes `evidence.json`
with runtime versions, HEAD/dirty status, request ledger, runtime errors and
measurements. Failure screenshots and traces are retained too. The next invocation
replaces that output; copy artifacts before a rerun if you need to compare them.
The one exception is the `chromium-classic-scrollbars` project, whose `evidence.json`,
failure screenshots and traces land in `test-results/browser-classic-scrollbars/`
so that its separate invocation cannot clear the measurement evidence.
A dirty-status listing is not a content hash; tie release claims to a separately
verified clean commit or source manifest.

## CI coverage and local-only WebKit checks

CI stays on `ubuntu-24.04`. `pnpm test:browser:ci` inherits the ordinary config and
excludes only tests tagged `@local-webkit` from `webkit-measurements`. Their Chromium
instances and every untagged WebKit case remain required. Both engines, serial
measurement order, zero retries, the documented functional assertions and
measurement ceilings, and the strict `CI required` aggregate remain in place.

CI shards each functional engine across six runners, without waiting for the
separate measurement runner. Each job selects its engine with `--no-deps` and
`--shard=N/6`; measurement success is enforced by `CI required`, not job ordering.
This preserves measurement isolation while spending more setup/runner minutes,
including when measurements fail. Local same-runner dependencies remain unchanged.
Artifacts include engine and shard so parallel jobs never overwrite one another.

The Node integration gate lists tests without launching browsers and checks that
the workflow's twelve selections cover every discovered functional test/project
exactly once, with no measurements included. It also exercises the required
check's shell against failed, skipped, cancelled and missing lane results.
These safeguards must change with the matrix; do not maintain feature allowlists
or move existing required cases out of CI to reduce its duration.

Cases tagged `@classic-scrollbars` need a scrollbar that takes space. They run
only in the `chromium-classic-scrollbars` project, which keeps Chromium's
platform scrollbars visible, and the engine projects exclude them. CI runs that
project as a second step of the measurements job, so `CI required` blocks on it;
the integration gate checks that the step exists and that the tagged cases are
selected there and nowhere else. Linux always draws classic scrollbars, so the
cases fail there if the scrollbar takes no space. On macOS Chromium follows the
system "Show scroll bars" setting, so they skip unless `BUZZ_CLASSIC_SCROLLBARS=1`
is set on a Mac whose scrollbars take space:

```sh
BUZZ_CLASSIC_SCROLLBARS=1 bin/pnpm test:browser --project chromium-classic-scrollbars --no-deps
```

The following **three WebKit cases are local-only**, not passing CI coverage:

| Case | Reason and coverage gap |
| --- | --- |
| `channel-opening.spec.mjs`: cold opening / warm switching | Originally excluded after hosted Linux WebKit recorded 104ms against the former <100ms budget. The warm gate now uses the target/ceiling policy below; this change does not revalidate Linux WebKit or restore its CI selection. The whole case remains local-only, including cold opening under held DM labels and no-new-head-read assertions. Chromium retains the full case in CI. |
| `scroll.spec.mjs`: cursor paging / large-history virtualization | Linux WebKit repeatedly stops short of the requested wheel edge. The cause remains unresolved between engine/input handling and the harness. Its 31 unique cursor requests, 640-message traversal, 4px anchors and DOM ceilings remain local-only on WebKit; Chromium retains them in CI. |
| `scroll.spec.mjs`: live edits / reading anchor | Linux WebKit's fetch reader can leave part of an edit undelivered while the SSE stream is open. WebKit growth/shrinkage and reading-anchor checks are local-only; Chromium retains the case in CI. The delivery defect is not fixed by this selection change. |

Evidence: [Linux run at `d25ed65`](https://github.com/block/buzz-app/actions/runs/34538518724)
and its measurement artifacts. Local Apple Silicon passes do not establish Linux
correctness or hosted repeatability. WebKit's other scrolling/append/reload case
and all functional journeys still run in Linux CI; unit/native tests do not
replace the three excluded WebKit cases.

```sh
bin/pnpm test:browser:ci          # same selection as Linux CI
bin/pnpm test:browser:local-only  # exactly the three WebKit cases, serially
bin/pnpm test:browser            # complete original suite, including those cases
```

The full suite remains part of `pnpm test` and `just scan` on every local platform;
these cases are not silently skipped on Linux. The local-only command may still
fail there. No macOS CI runner is configured. To restore a case to CI, remove its
tag only after the documented Linux functional assertions and measurement
ceilings pass repeatedly. Live-edit
closure also needs complete delivery on the open stream without a later write,
heartbeat or close rescuing it. Do not move ordinary app/test failures out of CI
or grow this exception list merely to get a green run.

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
label caller**, not just the reader's priority flag. Cached returns require no
new head request and visible correct-channel rows with the matching composer
across a paint opportunity. The existing **1s completion watchdog** still fails
an unfinished switch.

Warm timing keeps a **<100ms target** and a provisional **<200ms per-switch hard
ceiling**. All four browser-clock samples and the functional checks complete
before the ceiling is enforced; there are no retries or discarded outliers.
Target misses add `performance` annotations to the downloadable Playwright JSON
report (`ci-report.json` in CI), not the GitHub job-summary table. Raw timings,
first-visible times and frame diagnostics remain in `evidence.json`, including on
passing runs. Authors and reviewers should inspect target misses when changing
opening/rendering paths; green CI does not mean the 100ms target was met.

The ceiling is an explicit tolerance policy, not a statistically established
flake-free limit. Hosted Chromium recorded intermittent 111–120.5ms misses across
main and multiple PRs ([main](https://github.com/block/buzz-app/actions/runs/35925546559),
[#182](https://github.com/block/buzz-app/actions/runs/35932973673),
[#185](https://github.com/block/buzz-app/actions/runs/35936296156)). The 200ms ceiling
leaves roughly 80ms above the largest observed miss while retaining an automatic
slowdown alarm. The timer includes browser scheduling and layout observation as
well as application work: those samples do not establish runner contention as the
cause, and severe stalls can still fail. Regressions between 100ms and 200ms now
require performance review rather than automatically failing CI. This is not a
universal device/relay SLA or hardware input measurement.

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
normal `pnpm test` / `just scan` gate, which also runs in GitHub Actions (not relay-enforced).

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
The existing 2,400-row data-path test enforces deterministic fold/notification
counts and unaffected identities. It logs synchronous send time for comparison;
it does not impose a runner-dependent latency threshold or guarantee latency.

## Reading-position contract

View intent stores `{offset,bottom,anchor?:{id,y}}`, partitioned by community/viewer
and channel. Cold or oversized geometry uses the saved message ID and its row Y
with Virtua's index-based scrolling. Old offset-only records and anchors no longer
in the retained window fall back to the saved offset; this may clamp and cannot
promise the same message. No extra history is loaded just to recover an anchor.
Measured geometry stays in memory, with the unchanged three-entry / 256KiB
signature limits in `src/features/messages/geometry.ts`.

Panel opening/closing and viewport resizing preserve bottom intent or the visible
reading anchor. Restoration-generated scrolls retain that message while its row
intersects the viewport, even when narrower wrapping makes its paragraph too tall
to fit wholly. A new input gesture or local-send navigation releases that preference;
missing/offscreen rows use ordinary visible-anchor selection. A new input gesture
also supersedes a queued restoration. The layout
journey also checks separate cards, independent panel scrolling, window-centered
tabs, community-dialog focus, and widths down to 390px.

Closing a link panel returns focus to its still-mounted trigger without scrolling
that link into view. The layout journey observes the native focus call's scroll
delta as well as the final reading anchor: a transient focus jump must not be
hidden by a successful later virtualizer correction. The test explicitly moves
focus into the panel before closing; removing focus restoration must also fail.

Resize journeys use the existing tall-message fixture and assert no older-page
requests plus a reading position outside prefetch. The ordinary fixture holds
cursor responses for explicit paging tests; accidentally entering that path is not
valid resize setup. `upper()` establishes above-bottom reading with at most four
real wheel gestures, requiring progress and settled distance >400px. It does not
measure exact wheel displacement. Partial-input and blocked-input controls guard
that setup; same-ID/Y <4px and bottom <4px assertions remain unchanged. Anchor
capture prefers a whole paragraph, falling back to the first intersecting row
when tall messages leave only clipped paragraphs. A deterministic helper control
covers that geometry, whole-paragraph preference, offscreen rejection, and rejection
of an actual anchor displacement. No retries
or additional WebKit exclusions are used. The underlying Linux WebKit single-wheel
shortfall remains unattributed; this setup change does not fix or explain it.

`image-scroll.spec.mjs` separately holds image responses while real wheel input
establishes its reading/bottom setup. Traversal ends at the observed settled target,
not a fixed gesture count: virtualizer remeasurement and native input may apply
only part of a requested displacement. Every gesture must make directional
progress that remains after settling, and the existing test deadline bounds the
operation. A 400px partial-input control requires more than eight gestures; blocked
input must fail on its first gesture. Once image responses are released, no
corrective scrolling is allowed during the strict image/anchor assertions.

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

## Predicted row heights

`row-heights.spec.mjs` mounts the real `ChannelTimeline` with the app's fonts and
the bundled links and emoji plugins (revision `bundled`, registered before it
mounts) in a source fixture (`tests/fixtures/row-heights.tsx`, DEV, so client
metrics record). Layout, fonts and 1/64px layout units are the behavior, so only a
browser can check it, in both engines:

- **Exactness.** Three corpora, each mounted taller than itself so every row is
  sampled, at widths 480, 588.33, 613.37, 768 and 1100px and text scales 0.9, 1,
  1.1 and 1.3 (plus the 320px and 464px cells below), in both engines and in
  WebKit with a WKWebView user agent that has no `Safari/` token. Every row kind
  must report zero mismatches, and the fixture also asks the model for every
  row's outcome with the timeline's inputs: each predicted height must equal the
  row's height (per-row evidence; it must agree with the counters). The attached
  JSON reports per-cell counts, reasons and, for the inline and complex corpora,
  coverage by kind of row.
  - *Inline boxes*: mentions (a person's and an agent's button, bold, beside
    punctuation), link chips (short, long, Markdown, Buzz), channel references
    and custom emoji (served, failing, refused by the media policy). Every
    predicted row must be the size Virtua was seeded with; only `link-width`,
    knife edges, words wider than a line and bylines may be left to measurement;
    from 768px every row without a chip must be predicted, and at 1100px ×1 some
    chip rows. Rows of kind `declined:<reason>` lay out unlike the model, and each
    must report exactly its reason: buttons whose names need fallback fonts
    (emoji, Devanagari, Thai, Arabic: `mention-font`), link labels with a soft or
    hard line break (`link`) and agent spans, one with a name a line can break
    inside (`mentions`).
  - *Complex*: 300 rows from `tests/fixtures/complex-corpus.mjs`, the row kinds
    and shares measured read-only on a live community (membership rows, day
    dividers, thread summaries, reactions, links, person and agent mentions,
    images and video with dimensions, files, audio, inline code, lists, code
    blocks, quotes, long agent reports, tables, custom emoji, large emoji, sent
    from thread, emphasis, several paragraphs, a few rows in other scripts).
    Nothing predicted may differ and some rows must be predicted in every cell
    but 320px. The performance harnesses can use the same generator.
  - *Static*: a prose corpus (1 to 28 lines, three authors in runs, day
    boundaries, line breaks and paragraphs, strong, emphasis, strikethrough and
    their combinations, unbroken tokens, Cyrillic, Greek, Vietnamese, accented
    Latin, Arabic, Hebrew, Thai, Devanagari, Chinese, Korean, Japanese, mixed
    direction, emoji with joiners and flags, curly quotes, a link). Every predicted
    row must be the size Virtua was seeded with.
    The rows left to measurement must be exactly one reaction, and twice
    each CJK punctuation beside Latin text and curly quotes beside Han
    (`cjk-punctuation`), kerning across Pretext's pieces (`shaping`), a word split
    across two text nodes of one font (`glue`), nested strong, code, an en dash
    (`characters`), unverified punctuation in a word (`punctuation`), opening
    quotes after a word in another script (`scripts`), a punctuated number in
    Hebrew (`bidi`), an emoji glued to a word (`emoji`) and small kana (`kana`);
    with macOS fonts in Chromium, which kerns kana, also the two other kana rows
    twice. The link row may report `link-width`. Knife edges (`edge`), words wider
    than the line (`wrap`) and bylines are allowed for at most ten rows per cell
    (twenty in the 464px cell, where Chromium's integer column puts several rows on
    a layout-unit edge). A 1/64px pitch error fails at the first cell. At 320px ×1 no byline fits beside
    the widest time label, so every other timeline row must report `byline`;
    without the fit check they mismatch. The diagnostics behind the character
    allowlist and word rules (adversarial corpora for every admitted character
    and context, a random-word fuzzer reporting where the DOM and Pretext break
    differently, 200-800 widths, both engines and the Tauri UA, four scales) and
    behind atomic boxes (mentions, chips and emoji beside punctuation, in styles,
    in runs and in other scripts at 101-201 widths, four scales) are recorded in
    the R36 and R39 notes, not run here.
- **Font subsets.** With the Inter Cyrillic file held by `page.route`, the
  Russian rows report `font` and nothing mismatches; once it loads, a remount
  predicts them exactly.
- **Dynamics.** Runs with client metrics off (the module is rewritten in flight),
  as in production, so DEV sampling cannot prepare rows. Two older pages, held by
  the fixture's store, are released once wheel input reaches the older-history
  threshold: each may cost only the shift's own scroll write and no `ol` height
  change without a row-count change. In Chromium the first page is predicted and
  inserted under 6x CDP CPU throttling (its insert always predicts the page and
  the former first row). A remount at another width (no geometry
  snapshot applies), then a wheel traversal up and down across every row, must
  write nothing and change no `ol` height. Steps toward a page end at Virtua's
  scroll end, traversal steps at native `scrollend` and a settle; every read
  waits for Virtua's idle, two frames and a settle. Instrumentation is a page
  init script. Stock Virtua sizing (no estimator), a Virtua build that does not
  re-predict the former first row, and disabling the scroll-end preparation of
  measured rows each fail it. Rows passed
  within one continuous gesture are not covered: they are prepared only at a
  scroll end that finds them mounted.
- **Lifecycle.** A new timeline mounts only its viewport until an idle period
  (run by the test) or, for a second Virtualizer, the reader's first wheel; each
  then mounts rows beyond the viewport. Turning the buffer on from the first
  commit, or removing either trigger, fails it. Without `requestIdleCallback` (as
  in WebKit; every engine runs the case), a held quiet period leaves only the
  viewport until the first wheel, and the real one mounts the buffer without
  input; a task right after the next frame fails it (the quiet period's clock and
  restarts are unit-tested). An inline target reveal mounts
  rows beyond the viewport on both sides, and so does a timeline opened empty, or
  with three rows while the Pretext chunk is held, once 60 messages arrive in
  pages of 20 (fails if a seeded Virtualizer's buffer waits for Virtua's own
  estimate or an early Virtualizer is seeded later). A Virtualizer created
  without hover, or while the Pretext chunk is held, matches stock Virtua's list
  height, offset and mounted rows. A text-scale change while the pane is hidden
  recalibrates when it shows, keeps the reader at the bottom, seeds the new
  Virtualizer exactly (every mounted row sampled after a scroll end), and reports
  no ResizeObserver loop.

`scroll.spec.mjs` cursor paging additionally requires each released page to cost
exactly one scroller write (the jump); it fails on the parent commit. Assertions
read aggregate counters only; the attached JSON reports per-cell counts and
unpredicted reasons. The fast-path syntax check, the character allowlist and
word rules, and the creation-only cache prop have Node/jsdom tests
(`row-height/prose.test.ts`, `environment.test.ts`, `use-row-heights.test.tsx`).
Not covered yet: size changes of rows already in Virtua's cache (width, text
scale, fonts, edits), which wait for reconciliation; the fallback fonts of
Linux CI images (CJK, emoji, symbols), which differ from macOS: the kana count is
asserted on macOS only; and Chromium at a 1.2 text scale, where the Latin sample
matches no candidate canvas size, so calibration fails and rows are measured.

## History loading and live status

The history-loading journeys retain the production broker's HTTP admission. They
check that ordinary wheel paging begins before the top, and that a saved top
anchor can resume paging from a boundary gesture even when the DOM cannot scroll
farther. With tall messages, each wheel must land; in WebKit that also guards the
idle fill of predicted heights (docs/channels.md): creation predicts only a
few tall rows within its budget, and without the fill the rest correct as they
mount under the reader's wheels, which WebKit then drops (8 of 8 runs fail). Restoration alone does not fetch history. One blocked near-top gesture made on cached
rows waits for successful revalidation, including the live catch-up handoff;
errors, paging, moving away from the threshold, or unmounting retire that intent. A quota-failed page retains a
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


## Unread and durable reading

`unread.spec.mjs` opts into the production broker with ephemeral viewer/peer keys
and modeled upstream NIP-11, snapshots and publications. It keeps the built app,
React, session, IndexedDB, Web Locks and signing/encryption real. The tests observe
storage/results but never seed a journal or call a test-only engine API. They cover
focused visible dwell, non-reading opening/composer focus, individual markers,
encrypted publication/readback, reload, cancellation and local manual-unread.
The reload control holds network content so verified disk-restore wiring is required.
This is not a deployed-relay, native signer or cross-device integration test.

## Native input and transient effects

Before capturing a reading baseline, `timeline.mjs` arms a passive wheel observer
and waits for that gesture's `scrollend`, then settles layout. Linux WebKit can
pause longer than the geometry sampler's quiet window before applying the last
wheel movement. Geometry-only settlement is not input completion. Settings and
other baseline setup callers share this barrier with their actual scroll container.
`edge()` retains boundary input for paging: when already within the existing 4px
edge tolerance, movement and `scrollend` are not required. Non-boundary movement
must finish before `upper()` reverses direction.

Helper controls hold completion across a geometry pause, reject blocked input and
stale completion, drain timed-out DOM reads, and withhold a final edge displacement
before starting the reading gesture. These do not replace the app's strict same-ID/Y
and bottom assertions or establish guarantees for arbitrary Safari versions.

The New message journey records removal-effect insertion and cleanup before input,
then inspects both boundaries after cleanup. It retains real CSS animation and
reduced-motion checks instead of requiring automation to catch a 400ms DOM window.
The link-message source fixture imports the app's bundled Inter font and waits for
its loaded face before comparing native font boxes; a declared CSS family alone
can silently use platform fallback fonts.

## Fixture server isolation

Concurrent Vite fixture servers must own separate optimizer caches. Use
`tests/browser/vite-server.mjs` for new fixtures; its `close()` releases the owned
cache. The existing emoji and conversation fixtures retain their explicitly owned
temporary caches. Do not share Vite's default `node_modules/.vite`: another server
can invalidate dependency imports and leave a blank fixture with a 504
`Outdated Optimize Dep`. Keep import failures visible; retries or longer UI waits
do not repair module loading.
