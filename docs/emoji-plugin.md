# Emoji and conversation author preview

This checkpoint is **ready for feedback**, not release validation. Bundled Emoji
owns picker/Unicode selection and custom image rendering. The shared session keeps
the catalog, media policy, signed emoji tags, event-local URLs and durable outbox.
Channels has no dependency on the Emoji implementation.

## Try on a laptop

Use a separate checkout/worktree of this branch. Do not switch a running server's
worktree beneath it. From that checkout:

```sh
source bin/activate-hermit
pnpm install --frozen-lockfile
pnpm author:build
(cd dist-author && pnpm pack --pack-destination ..)

# Build an independent plugin from the packed public declarations.
LAB=$(mktemp -d /tmp/buzz-composer-lab.XXXXXX)
cp -R examples/composer-lab/. "$LAB/"
pnpm --dir "$LAB" add -D "$PWD/buzz-author-0.0.0-preview.1.tgz"
pnpm --dir "$LAB" build

# Isolate plugin settings/artifacts; this does NOT isolate Keychain credentials.
export BUZZODZ_HOME="$LAB/plugin-home"
export BUZZODZ_PROFILE=emoji-feedback
pnpm buzzodz plugin install "$LAB/dist"
pnpm buzzodz plugin enable example.composer-lab
just desktop
```

`just desktop` opens the Buzz Foundation dev app, without live identity by default.
Close only that dev instance when done. Run only one server on port 1430. Native
catalog/scaffold edits require rebuilding the process; Vite HMR alone is not enough.

For real Channels/Lab data, deliberately configure the existing public identity
pin described in [README](../README.md#relay-channels), then start
`BUZZ_LIVE=1 just desktop` **instead**. This uses the existing Keychain account;
sends from either page are real posts. Do not use real memberships, revocation or
credential changes as test setup. Packaged sign-in remains a separate product gate.

1. Open Channels and Composer Lab. Both should offer **Time** and **Insert emoji**.
   Lab is a simple same-session consumer, not a second Channels implementation.
2. Type a draft and select a member. Open Emoji, then disable **Emoji** in Settings.
   The editor/mention data must remain; custom body/reaction shortcodes stay readable.
   Re-enable: one picker only, historical custom images return.
3. In Lab, open the picker and press **Rerender Lab**. It must not remount the editor
   or picker. Programmatic browser tests additionally assert exact node identity,
   focus, caret and search retention.
4. Change community/channel with the picker open. A late selection must not enter
   the new destination's draft. Revisit the original destination to inspect its draft.
5. Rebuild a changed Lab label and repeat `plugin install "$LAB/dist"`. An enabled
   update should appear once, without losing the host draft. Use `plugin rollback
   example.composer-lab`, then disable/re-enable. Settings supports these actions too.

No live writes are necessary for basic toggle/installation feedback. Signing and
retry assertions in automation use generated test keys and isolated transports.

## Public author contract

Generate `@buzz/author` from authoritative host declarations, then distribute the
packed archive. The package is **type-only**, private/unpublished preview
`0.0.0-preview.1`. Import `Context` and props with `import type`; runtime values
come exclusively from injected `ctx`. The CLI scaffold uses this same entry and
asks the author to install the matching archive; it no longer copies Context.

```ts
import type { Context } from "@buzz/author";
export const inject = ["react", "conversation"];
export function apply(ctx: Context) {
  ctx.conversation.registerTool({
    id: "timestamp", title: "Insert timestamp",
    component: ({ insertText, disabled }) => ctx.react.createElement("button", {
      type: "button", disabled,
      onClick: () => insertText(new Date().toISOString()),
    }, "Time"),
  });
}
```

- `conversation.ui.Composer` and `.Message` are stable host components. Ordinary
  props specify destination/session; the composer owns its remount/draft boundary.
  No external Timeline/Thread SDK or additional hooks layer is introduced.
- `registerTool` and `registerInline` stay **top-level service methods**, allowing
  Cordis to bind registrations to the calling plugin's lifetime. Readers are plain
  `tools`/`inline` bags; React components live in the stable `ui` bag because Cordis
  changes top-level function-property identity on each read.
- Editing commands serialize same-turn inserts, preserve mention ranges, enforce
  the message limit, and return false when revoked/disabled. Exact registration
  identity and component lifetime fence stale handles. Popovers still own/cancel
  their own delayed work when closing and reopening.
- Inline matchers see plain non-link text and event-local metadata. Offsets are
  UTF-16; first registered match wins overlap; malformed/throwing matches are
  skipped. Render errors fall back to text. Reactions carry their own mappings,
  never the parent message's or current catalog's URL.
- Catalog recovery remains host-owned and reachable after disabling Emoji. A
  failed preparation leaves the draft and offers **Retry message preparation**;
  recovery never automatically sends or re-signs an existing outgoing event.
- Trusted plugins still receive full session authority. Narrow editing helpers
  are convenience/lifetime controls, **not a sandbox or security boundary**.

Preview archives must match the host checkpoint. Bump the preview version for
incompatible author changes and rerun the archived external-artifact journey;
there is no cross-version compatibility promise yet. Manifest API v1 describes
module packaging, not service availability. An older host lacking `conversation`
leaves a requiring plugin unavailable and reports activation failure; it must not
silently import private implementation paths. Runtime imports/assets, bundled
second React and automatic JSX runtime remain unsupported.

## Evidence and remaining gates

The new browser journey packs declarations into a separate temporary directory,
builds Composer Lab outside the checkout, installs through the real Rust Manager
into an isolated home, then loads those immutable bytes through a test bridge and
the ordinary JS plugin runtime. It covers Channels/Lab reuse, parent rerenders,
same-turn edits, immediate removed-callback rejection, disable/re-enable,
community retarget, rollback/update, catalog retry, signed tags and exact-event
retry. This **is not a Tauri IPC or packaged-app proof**.

Remaining before integration: final full batch (`just scan`), production-wiring
mutation controls, final independent implementation review and human native
install/update/toggle acceptance. Broader independent panel, native identity,
stalled-cleanup and distribution gates in [status](status.md) stay open.
