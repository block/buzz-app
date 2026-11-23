# Coordination visual review

This opt-in suite adds screenshot comparison for the coordination disclosure
change. It is separate from the behavioral browser journeys and their CI shards;
it does not change the general preference for behavioral tests. It uses the
existing production frontend/broker fixture, not a reimplemented renderer.

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

Both light and dark themes capture a grouped channel run collapsed and expanded,
and an individual thread row collapsed and expanded. A real nested reply forces
that row out of the grouped renderer. The person-directed sibling must retain its
content preview, and original text/source links remain inspectable on expansion.
These snapshots are not native-host or live-relay acceptance.

The historical goldens were first rendered and then compared successfully on
unchanged product source `f373cea21d979a23f27920bbb89b98cf05b8c73d`, with only this
visual test/config added in an isolated worktree. This reconstructs the actual
pre-change baseline; it is not a claim that screenshot tests existed before the
feature was implemented. This tooling/baseline layer leaves product source
unchanged. A dependent behavior PR updates the same image identities to the
quieter presentation, exposing the visual delta against this baseline.

Goldens are separated by engine and OS. The initial set is **macOS only**;
Linux CI is not wired to this opt-in suite and macOS images must not be renamed
as Linux baselines. Use the same OS and pinned Playwright/browser/font versions
when comparing. New platform baselines require an independently inspected
capture on that platform, not a tolerance increase or an automatic acceptance.
