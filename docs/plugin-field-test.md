# Handoff Board plugin field test

The [Handoff Board example](../examples/plugins/handoff-board/) began as a separate local project built with `buzzodz plugin init` and the packed `@buzz/author` declarations. It adds a task page, a top-bar panel sharing the same store, and Cmd/Ctrl+Shift+H navigation. Human/Agent is an assignment label; it does not start an agent. No host runtime changes were needed.

## What worked

The documented scaffold, author-package packing, build and installation commands worked. Host React, pages, panels, shortcuts and navigation composed through the public plugin contract. Installations started disabled. Disabling removed contributions and released the shortcut; updating and rolling back an enabled installation replaced its contributions without losing the sample's saved tasks.

The store belongs to one `apply()` lifetime, so the page and panel share state across React mounts. A sample defect initially returned an empty snapshot after loading saved tasks. The reload check caught it; the example now has an initial-snapshot regression test. This was a sample defect, not a host defect.

## Developer findings

These diagnostics were reproduced on a9194b24a3cc208abf6f9a9a05eed77583e6c0fa with Vite 8.2.2. The implicated plugin-manager and runtime files are unchanged at ed271ff.

### Unsupported CSS builds and installs without its stylesheet

1. Scaffold a plugin and import `./style.css` from its entry. Add `declare module "*.css"` so TypeScript accepts the import.
2. Define a class with `color: blue` and use it in the plugin component.
3. Run `buzzodz plugin build`, install the output directory and enable the plugin.

Observed: build succeeds and emits a separate CSS file. Installation succeeds but copies only `manifest.json` and `plugin.js`; the stylesheet is absent and the element renders black rather than blue.

The [scaffold guard](../crates/plugin-manager/src/main.rs) uses `enforce: 'pre'` and checks outputs in `generateBundle`. With the pinned Vite version, that check precedes the CSS-emitting hook. The [artifact reader](../crates/plugin-manager/src/lib.rs) accepts the two supported files. A successful build therefore does not establish that every emitted file will be installed.

Suggested follow-up: check final outputs and reject unsupported assets with an actionable error. Asset support can remain a separate product decision. Handoff Board uses inline styles.

### Missing dependencies produce an unnamed activation timeout

Install an API-v1 module declaring `inject = ["pages", "noSuchCapability"]`. Installation succeeds. Enabling waits about 10.7 seconds, then Settings reports `Error: Plugin activation timed out`; `apply()` never runs. CLI `list` reports the saved enabled flag, which is distinct from frontend activation health.

The [runtime](../src/plugins/runtime.ts) reports the timeout without naming unavailable services. Suggested follow-up: identify unavailable declared dependencies in pending and failed status. A missing service can be temporarily unavailable, so an error should not classify every missing name as a typo.

## Documented preview limitations

| Area | What the sample establishes |
| --- | --- |
| Persistence | There is no plugin-owned storage API. The example implements loading, validation, recovery and save errors with namespaced `localStorage`. |
| Scope and removal | `localStorage` belongs to the browser/WebView origin. It is not partitioned by Buzz profile, account or community. Uninstall retains it. A separate native-manager home on the same browser origin reads the existing board. |
| Compatibility | `apiVersion: 2` is rejected before installation and leaves the registry unchanged. Version 1 and the preview author package do not negotiate individual service versions. No stale-SDK compatibility experiment was run. |
| Iteration | Scaffold and build commands are available and documented. Full-app external-plugin tests required an IPC adapter around the repository's Rust fixture manager. A supported temporary-profile preview/test command would reduce author setup. |
| Panel shortcut | The public shortcut opens the board page through navigation. The sample does not assume an undocumented API for toggling its panel. |

Persistence scope, cleanup and service compatibility need explicit contracts before authors can depend on them. These are preview limitations, not promises the host has broken.

## Verification boundary

The original field test passed 12 lifecycle checks in each of Chromium and WebKit: disabled installation, activation, edits/navigation, shared page/panel state, reload, shortcut, disable cleanup, re-enable, update, rollback, removal, and storage across manager homes. The sample also has six store tests covering saved-state loading, malformed data, partial recovery, save errors and task mutations.

The browser checks exercise the production App, platform storage adapter, module loader, Cordis runtime and real Rust plugin manager. A Playwright binding replaces the Tauri IPC transport with the repository's `fixture-bridge` executable. Screenshots and recordings in the accompanying PR use that boundary and synthetic tasks.

The earlier native app build and launch succeeded, but native-window interaction was not verified. Browser evidence does not establish OS file-picker behavior, native-window behavior, live relay collaboration, mobile support or security isolation. The board is local-only.
