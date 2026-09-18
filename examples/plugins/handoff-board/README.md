# Handoff Board

Ready to install: select this folder in desktop Settings → Plugins, then enable
**Handoff Board**. `manifest.json` and prebuilt `plugin.js` are included; no build is
required.

A local, offline task queue for handing off short work items between a person and an
agent. Registers a page, a top-bar launcher panel, and one keyboard shortcut, all
sharing the same task list. Requires `react`, `pages`, `panels`, `navigation`, and
`shortcuts`.

- **Page** (`board`): add a task (title + owner), change its status
  (queued / in-progress / done), remove it.
- **Top-bar launcher / companion panel** (same `board` id): a compact view of the same
  list, reading and writing the same store.
- **Shortcut**: Cmd+Shift+H / Ctrl+Shift+H opens the Handoff Board page via
  `ctx.navigation.open(...)`.

Assigning a task to **Agent** in the UI is only a label stored on that task. It does
not invoke, notify, or communicate with any agent.

## Persistence — local only, not synced

This plugin stores its data directly in `localStorage`, namespaced under the key
`buzz-plugin.local.handoff-board.v1`, because the host has no plugin persistence API yet.

- `localStorage` is scoped to the browser/WebView **origin**, not to a `BUZZODZ_PROFILE`,
  Buzz community, or account. Data is not synced across devices or origins, and is not
  collaborative.
- Uninstalling/removing the plugin does **not** delete this data; it stays in
  `localStorage` under the same key until cleared by other means.
- If `localStorage` is unavailable, or a write fails (e.g. quota), the board shows a
  visible error banner rather than silently claiming the save worked.
- If the saved data is corrupted or has an unrecognized shape, invalid entries are
  dropped and a recoverable-data notice is shown rather than crashing the page.

For source changes only: copy this folder outside the host checkout, install the
host-matched packed `@buzz/author` preview with `pnpm add -D /absolute/path/buzz-author-VERSION.tgz`,
then `pnpm build`. Install the resulting `dist` folder through desktop Settings
or `buzzodz plugin install`. Refresh the checked-in `plugin.js` from that build
when changing the example source. New installs start disabled.

This example has no relay/network access and imports no host runtime module; only
type-only imports from `@buzz/author`, matching the other example plugins.

Run `pnpm test` (after installing dependencies alongside the `@buzz/author` preview) to
exercise `src/store.ts`'s persistence and recovery behavior.

See [docs/plugin-field-test.md](../../../docs/plugin-field-test.md) for the field test that
built and verified this example, including host findings surfaced along the way.
