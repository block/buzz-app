# Messages visual review

This opt-in messages suite starts with one focused activity-history scenario to
provide comparable evidence for the later quieter-presentation commit. It is
separate from behavioral browser journeys and their CI shards; it does not change
the general preference for behavioral tests. It uses the existing production
frontend/broker fixture, not a reimplemented renderer. The suite is organized by
product area, not by the feature in the later commit; broader message coverage is
outside this change.

```sh
bin/pnpm test:visual                        # compare both engines
bin/pnpm test:visual --project chromium     # one engine
bin/pnpm test:visual --update-snapshots     # only after inspecting the differences
```

Install the pinned browsers with `bin/pnpm test:browser:install` if needed.
Playwright writes expected/actual/diff images, traces and videos under
`test-results/visual/` on a mismatch. Each run replaces that output. Image
assertions allow zero differing pixels; animation is disabled, dates and fixture
keys are fixed, bundled fonts are loaded, and captures exclude unrelated chrome.

## Coverage and provenance

Both light and dark themes show two consecutive public agent messages as
separate, fully visible rows. They have known-agent recipients but no
`audience: agents` flag, and remain ungrouped before and after the preview change.
The same channel also contains two explicitly agent-only messages, which main
already groups behind its existing activity-history disclosure. The captures
show that history before and after opening it, plus an individual thread row.
Grouped avatars and disclosure states are existing behavior, not features
introduced by the later quieter-presentation commit.

A real nested reply forces the thread row out of the grouped renderer. Its
person-directed sibling must retain its content preview, and original text/source
links remain inspectable on expansion. These snapshots are not native-host or
live-relay acceptance.

The baseline commit renders all 16 goldens on unchanged product source
`ac0b9bbd619b73a08ca1e48d1af1ec588bf4f40b`, with only the visual tooling added.
The later behavior commit keeps the same scenario and updates only the eight
collapsed images to expose the quieter label/typography; it does not introduce
grouping. The public agent rows and expanded history remain unchanged.

An earlier version without the public-agent pair was also rendered on historical
unchanged source `f373cea21d979a23f27920bbb89b98cf05b8c73d` and then main
`ac0b9bbd619b73a08ca1e48d1af1ec588bf4f40b`; those two sets were byte-identical.
The current channel images are newly captured with the public-agent pair, not
claimed to be identical to those earlier images.

Goldens are separated by engine and OS. The initial set is **macOS only**;
Linux CI is not wired to this opt-in suite and macOS images must not be renamed
as Linux baselines. Use the same OS and pinned Playwright/browser/font versions
when comparing. New platform baselines require an independently inspected
capture on that platform, not a tolerance increase or an automatic acceptance.
