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

The host still owns the appearance lifecycle. Its current stylesheet excludes the
new system from automatic Tailwind discovery so this port does not accidentally
restyle existing surfaces. That isolation protects the initial import; it does not
make the design system viewer-only or forbid app code from adopting it.

New and migrated app UI should use the shared components and tokens. Integrate the
system's global styles deliberately through the host entry point rather than
layering two resets, map current token meanings where compatibility requires it,
and retire old names as their callers move. Keep the host as the one appearance
owner, and keep app/plugin behavior out of shared UI. The viewer remains a separate
document with its own appearance-storage key and is not an external-plugin API.
