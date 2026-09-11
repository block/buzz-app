# Buzz design system

The design system this app is moving to, imported from `block/buzz`'s `desktop-new`
worktree, including its in-progress layout playgrounds. It is the styling source
for new UI and for existing surfaces as they move onto the system. This initial
port adds the system and its viewer without migrating existing app surfaces.

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

The host owns the appearance lifecycle and now loads the shared palette,
typography roles, materials and component styles through its coordinated entry.
Existing UI keeps temporary legacy styling until deliberately migrated. Shared
primitives mark their own styling boundary, including portal roots; new product
compositions use those primitives and named roles, never viewer furniture.

See [the host integration contract](../../../docs/design-system.md#incremental-system-integration)
for compatibility names, text scaling, keyboard focus and actual-app regression coverage.
The viewer stays an independent document and preference owner. Workspace experiments
remain excluded from host startup; BentoWorkspace still reads viewer preferences
and needs a host adapter before product adoption.
