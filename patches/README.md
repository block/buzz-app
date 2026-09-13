# Virtua 0.51.0 macOS WebKit compensation

The application imports the React ESM entry (`virtua` → `lib/index.js`) from
`src/features/messages/ChannelTimeline.tsx`. This patch changes only that entry;
unused CommonJS, core, and other-framework exports are intentionally untouched.
The dependency remains pinned to 0.51.0. Review the patch and the version-coupled
store extraction test together before upgrading or adding a different import.

## Why both changes are necessary

A system WKWebView reproduction prepends history during native scrolling. Stock
Virtua applies an immediate offset correction, then briefly observes the old
scroll offset with the new row positions: every mounted row is outside the
viewport. The recorded window visibly blanks. This observation does not establish
which internal WebKit IPC or compositor mechanism caused the offset discrepancy.

On macOS WebKit, reuse Virtua's existing deferred-jump path while the store reports
scrolling. Pending compensation already shifts rows by `-pendingJump`; publish
`layoutTotal - pendingJump` too. Deferring the correction alone leaves empty
trailing scroll space, reproduced by reversing toward the old bottom. The existing
scroll-idle transition clears the pending jump, restores full extent and applies
the accumulated correction. It is observer-inferred idle, not acknowledgement
that native input has ended.

The macOS predicate excludes Virtua's existing iOS detector (including desktop-mode
iPad). Existing iOS behavior, macOS Chrome/Firefox and non-Mac WebKit are unchanged.
The stale source-map directive is removed because this patch changes generated
code without regenerating the upstream map.

## Regression checks and limits

```sh
bin/pnpm install --frozen-lockfile
bin/pnpm exec vitest run src/features/messages/virtua-compensation.test.mjs
bin/pnpm test:browser history-loading.spec.mjs image-scroll.spec.mjs initial-position.spec.mjs \
  --project chromium --project webkit --no-deps --workers=1
```

The nine store tests evaluate the installed ESM bundle, not a copied model. They
cover deferred prepend, matching row/extent accounting, reverse-to-bottom,
positive/negative measurements, one-time idle flush, idle prepend and unchanged
platforms. Removing either behavior change fails assertions; removing the iOS
exclusion fails its platform control. These tests do not reproduce native paint.

Native acceptance requires a system WKWebView with phase-bearing wheel/momentum
input, a settled production ChannelTimeline with fixed messages, and one history
prepend during that input. Compare stock and patched bundles. Check both the
recorded feed pixels and the original message's per-frame position. Repeat with
upward input, reversal toward the old bottom, and prepend during momentum; the
reading anchor must remain continuous and newly exposed trailing space must not
be blank. Ordinary headless WebKit wheel tests are not equivalent native input.

Observed on macOS 26.6.2: stock blanks transiently; the patched native trials keep
rows visible and retain the original reading position through compensation.
This does **not** establish repair of persistent missing pixels when row geometry
is already correct, nor constitute signed-release or cross-platform acceptance.
