# Client performance metrics

Development builds record how quickly channels open, where their rows come
from, what warming costs the main thread, and how long live coverage takes to
set up. The numbers stay in memory in the page. Nothing is sent anywhere, and
production builds and unit tests get a no-op recorder
([`client-metrics.ts`](../src/features/developer/client-metrics.ts)).

## Viewing and exporting

Run `just web` or `just desktop`, use the app, then open **Settings →
Developer → Client performance**. **Export JSON** downloads the summary and
the raw records, so builds can be compared side by side. **Reset** clears the
records and keeps the current connection's coverage. In the browser console,
`__buzzClientMetrics.summary()` returns the same data.

To record a baseline for a build: reload, wait for the sidebar to settle, open
the channels you usually read (by click or keyboard), then export. Repeat on
the other build with the same roster and the same order.

## What is measured

| Metric | Definition |
|---|---|
| Click-to-content | From the sidebar click or keyboard event (or, for other routes, the pane switch) to the first paint after one of its rows is in the DOM. |
| Wait / render | Each open splits at the moment the store first holds rows for the channel. **Wait** runs until then: a disk read or relay request, or zero when the rows were already there. **Render** is the rest, from rows in memory to rows on screen. The panel shows the median of each part, so the parts need not add up to the median total. |
| Source | `memory`: rows were already on the device from this session. `disk`: restored from IndexedDB before the open. `disk-late`: the open waited, then a disk restore arrived before the network read did. `network`: the open waited for a relay read. |
| Cache-hit rate | Share of opens served from `memory` or `disk`, with no network wait. |
| Long tasks | Long-task entries where the engine supports them (Chromium). WebKit has none, so it uses event-loop lag of at least 50 ms instead. Tasks that overlap a disk restore or a background read count as background. |
| CPU | Time spent verifying signatures (`verify.read`, `verify.restore`) and folding rows (`fold`), measured per batch or window, never per event. |
| Reads | `/query` calls (and the broker's channel-activity reads), with decoded response size in UTF-16 code units (about bytes for JSON). They are grouped by phase: the app open, then each reconnect. |
| Live coverage | Per phase: time from connecting to the socket authenticating, and to every channel route being live (or failed). Also each route's pending→live time after authentication. |

Opens with nothing to paint are not timed: empty or failed channels, and
rows kept offscreen by a saved scroll position. The summary counts them as
**Not timed**.

## Live setup probe

`pnpm probe:live` compares ways of setting up live subscriptions against a
real relay. Each run uses a fresh authenticated socket.

```sh
BUZZ_PRIVATE_KEY=nsec1… BUZZ_RELAY_URL=wss://relay.example pnpm probe:live \
  --strategies idle,client:1,client:4,client:16,client:all,filters:10,multi-h:all \
  --runs 3 --json probe.json
```

| Strategy | What it sends |
|---|---|
| `client:K` | The app's own subscriber ([`live.ts`](../src/features/relay/live.ts)) with K setups outstanding. The app uses 4. It includes the profile and membership routes. |
| `filters:F` | All channels at once, F per REQ, one `#h` channel per filter. The relay allows at most 10 filters per REQ. |
| `multi-h:M` | All channels at once, M channels in one filter's `#h` per REQ. |
| `idle` | Nothing, which gives a baseline for the canary. |

Without `--channels` (a comma-separated list or `@file`), it probes every
channel the identity is a member of. It reports medians of:

- **coverage:** from authentication to the last channel reaching EOSE;
- **per-REQ time:** from send to EOSE;
- **canary:** how long a one-filter REQ sent right after the burst took to
  reach EOSE, compared with `idle`;
- **failures:** refusals by reason, summed over runs.

A run that misses `--timeout` (30 s by default) is counted as `incomplete`,
and that strategy then reports no coverage median, since a median over only
the finished runs would favour it.

Refusals such as `rate-limited: quota exceeded` count as failures for the raw
strategies. The app's subscriber retries them itself. Runs rotate their order
and pause 10 s between runs so one run's quota use doesn't spill into the next.
The probe checks only that setup reaches EOSE; it does not check live event
delivery after that.
