# Synthetic trusted-host chat-card checkpoint F1

This is **not Runway**, credential setup, a saved connection, provider transport,
media delivery or publication authority. It is an isolated macOS checkpoint of
one installed synthetic plugin, the production conversation card and native
one-shot enforcement. Installed UI/plugins are trusted; the internal main-renderer
bridge is **not** physical-human attestation against compromised renderer code.

## Owners and isolation

The debug-only native fixture installs/enables `plugin.js` with the real Manager,
pins the locally built closed synthetic recipient, and loads/activates the module
through the normal loader/PluginRuntime. Its local synthetic reader has no signer
or relay transport. `ConversationService.ui.Message` mounts the production
`MessageRow` → `MessageCard` path, with its real registry and reader forwarding.
The plugin contributes draft text and a call-ID locator only. Buzz displays the
native-frozen request/destination and owns Approve and run; no plugin approval
callback or Settings fallback is used. Native retains the pending operation and
final consume/page/registry/artifact/deadline/spawn fence.

Normal app startup, identity/Keychain, saved communities, provider adapters,
native automation bridge and helper installers are not started. Vite does not
load ordinary configuration or `.env` files. Only native-created synthetic
material enters the private fake-recipient envelope; there is no credential field
or getter. No provider/network/media operation is part of the fixture.

The experimental manifest is incompatible with the inspected bare-base CLI's
strict parser. **Never use shared/default desktop storage** or recover it as a
schema downgrade. Only the temporary home/profile printed by this fixture is in
scope. Closing the fixture removes its temporary registry/cache on normal exit.

The fixture uses one fixed call ID throughout its app process. It never retries,
renews or automatically recreates after Cancel, rejection, UNKNOWN, reload,
re-enable or card remount. Native tombstones survive page retirement. A deliberate
fresh app launch creates a new disposable run; it is not recovery of an unknown
operation. The typed synthetic destination constrains dispatch and receipt only,
not relay publication.

## Build only — no window

Use pinned repository tools; no new dependencies or installation:

```sh
bin/cargo build --locked --offline -p Buzz --example reviewed-input-recipient --example reviewed-native-fixture
bin/pnpm exec tsc --noEmit -p tests/fixtures/reviewed-invocation/tsconfig.json
bin/pnpm exec vite build --config tests/fixtures/reviewed-invocation/vite.config.mjs
```

The closed recipient reads a bounded private stdin envelope, validates its exact
request digest and synthetic `fake-` material, and emits only `{attempt,digest}`
on success. No provider/network/script/filesystem/logging behavior, arguments or
environment configuration. Native verifies/snapshots its read-only artifact
generation before dispatch. This is not a sandbox against trusted same-user apps.

## Launch only after explicit human readiness

**Do not launch before the human is ready for a disposable native window. No
accessibility, browser or substitute UI automation may choose the action.**
In two repository-root terminals:

```sh
bin/pnpm exec vite --config tests/fixtures/reviewed-invocation/vite.config.mjs
# After 127.0.0.1:1439 is ready:
target/debug/examples/reviewed-native-fixture
```

No native generation popup should appear. The installed plugin draft sits beside
Buzz's frozen request and typed destination. Approve and run is disabled until
the exact native projection arrives. Only that host button requests dispatch;
there is no credential input. A matching `submitted` receipt proves the pinned
synthetic recipient validated that envelope, not provider delivery or playback.

Record exact source manifest, executable hashes, shown body/destination, human
action and receipt for each fresh run. Human checks:

- Pointer activation and focused Space/Return each cause one submission, never
  two. Ordinary composer Return is not approval; this minimal fixture has no
  composer, so composer-shortcut integration needs separate product evidence.
- Cancel sends nothing. Close/unmount/reload while pending retires the original
  record; a later remount/re-enable does not renew the fixed call ID.
- At the fixed120-second deadline, the pending operation becomes cancelled and
  the action is disabled without needing a click. Reopening does not renew it.
- Disable/re-enable the installed plugin only against the printed temporary
  registry with a compatible candidate CLI. Final dispatch refuses after any
  registry save, including an unrelated change. Registry changes are checked at
  final dispatch, not polled for immediate visual invalidation.
- Unknown/missing/mismatched acknowledgements remain consumed. The five-second
  execution deadline bounds/kills the child group. No automatic retry appears.
- Use Switch theme and Change text size, resize narrow/wide, and exercise Tab,
  pointer and Details. Record contrast, reflow, focus ring and readability as
  performed or deferred. The fixture uses shared Button/disclosure semantics,
  the app stylesheet and keyboard-modality hook; static checks are not UX proof.

Deterministic native tests count actual pinned test-peer process admissions through
the retained production native command. Mounted tests exercise the registered
conversation and production MessageRow context. Those prove their stated seams,
not a human click or packaged-app integration. Do not replace deferred human
interaction evidence with a mock callback and call the checkpoint accepted.

Close the owned disposable window and stop its dev server when done. No installed
connection or credential survives.
