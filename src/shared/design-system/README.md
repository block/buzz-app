# Buzz design system

The design system this app is moving to, imported from `block/buzz`'s `desktop-new`
worktree, including its in-progress layout playgrounds. Surfaces transition onto it
incrementally; this change adds the system and its viewer without restyling the app.

## Ownership and locations

- `src/shared/design-system/`: shared components, tokens, styles, chip presentation helpers, registries and colocated tests.
- `tests/fixtures/design-system/`: standalone viewer, documentation pages and interactive specimens. It renders the real shared components, not copies.
- `scripts/design-system/`: scoped type, color, contrast and token-consumer checks.

Read `DESIGN.md` for design decisions and `MAINTAINING_DESIGN_SYSTEM.md` for
stewardship. Proposed work retains its status; historical examples in the design
guide are rationale, not a claim that those features were ported.

## Run from the repository root

```sh
bin/pnpm install --frozen-lockfile
bin/pnpm design:dev
```

Open http://localhost:1442/tests/fixtures/design-system.html.
The same fixture URL works under the normal web dev server.

```sh
bin/pnpm design:typecheck
bin/pnpm design:check
bin/pnpm design:census
bin/pnpm design:test
bin/pnpm design:test:browser
```

The browser command builds the host and viewer, then tests Chromium and WebKit.
`bin/pnpm design:build` produces `dist/design-system`; serve that directory and
open `tests/fixtures/design-system.html`. Hash links survive static-host reloads.
The build rejects source outside the system/viewer and copies no public directory,
native configuration or source maps. No publishing configuration is included.

## What is intentionally absent

No session shell, navigation controller, agent setup/activity, composer,
conversation feature, relay client, native adapter, local lab or identity data.
Blank layout playgrounds and generic inline reference presentations are retained.

## Compatibility boundary

The host still owns its existing tokens and appearance lifecycle. Its stylesheet
only excludes staged source from Tailwind discovery; no host role is remapped.
The viewer has its own document and appearance-storage key. Do not import its
global stylesheet into the host yet: its reset, root variables and utilities
are a replacement, not an additive theme. This staging area is not a second
permanently supported design system or an external-plugin API.

App adoption is separate: map current token meanings to the replacement, migrate
consumers in reviewed batches, preserve host appearance ownership, and retire
compatibility names after their callers move. Foundation changes need explicit
approval. Keep app/plugin behavior out of shared UI.
