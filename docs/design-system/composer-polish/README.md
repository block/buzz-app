# Composer polish checkpoint

User-provided visual references from September 22, 2026. These screenshots
capture the design iteration; later changes consolidate the picker surfaces
onto the shared Base UI Popover wrapper.

This is a work-in-progress checkpoint, not a ready-for-review or release claim.

## Screenshots

- [Resting composer](composer-resting.png)
- [Mention picker](mention-picker.png)
- [Emoji picker](emoji-picker.png)
- [Inline mention completion](inline-mention-completion.png)
- [Composer in the desktop app](composer-in-app.png)

## Validation at this checkpoint

- TypeScript and design-system checks, tests, and viewer build passed.
- Focused Chromium and WebKit coverage passed for mention selection, emoji/GIF
  pickers, editor completion interactions, and channel-activity popovers.
- Mention component tests passed.
- The latest shared-popover migration was inspected in the browser preview.
  Native desktop revalidation, broad integration checks, CI, and review remain
  deferred.

## Main reconciliation — September 23, 2026

Merged `origin/main` at `5677876` into the composer checkpoint. Main owns the
Button/IconButton implementation, recipient avatars, inline mention chips,
remembered-agent drafts, shared identity names and keyboard-only editor focus.
The composer spacing, shared popovers, search styling and picker keyboard behavior
remain from this branch.

Validation of the merge, before restoring pre-existing local gallery files:

- App TypeScript passed; 95 focused composer, mention and control tests passed.
- Design typecheck, guards, 80 design tests and viewer build passed.
- All selected browser cases passed in Chromium and WebKit across the affected
  file runs: conversation, emoji, GIFs, mentions, messages, typeahead, design-system
  and product-ui (72 cases total). No browser cases were added or removed.
- Reconciliation failures were reproduced before fixing stale region selectors,
  fixture startup ordering, shared-popover style probes, and the consumer fixture's
  rerender trigger. The latter now dispatches a fixture event so it tests parent
  rendering without also requesting outside-click dismissal. Existing persistence,
  publication, focus and DOM-identity assertions remain intact.
- The staged-file format/lint/icon hook passed. The existing custom Git hooks were
  preserved; the repository's `check-staged` group was also invoked explicitly.

The product-ui lab fixture still logs a missing `session.names.subscribe` error
when inline completion activates; its incomplete session fixture is inherited
from main and remains follow-up work. Passing picker tests do not validate that
lab's inline completion. Native desktop revalidation, broad integration checks,
CI and review remain deferred. This is still a WIP checkpoint, not release-ready.

## Main reconciliation — September 24, 2026

Merged 31 incoming commits through `origin/main` at `597c0971`. Preserved the
composer's shared popovers, whole-composer anchoring and stable emoji/GIF tabs.
Integrated main's rich-text formatting, reaction picker, draft recipient roster,
and canonical session agent choices. Search fields now follow main's shared
12px-radius, inset-filled form treatment; the old capsule recipe was removed.

Validation before restoring pre-existing local gallery edits:

- 129 composer/mention unit tests passed after reconciliation; the initial run
  also passed the edit-integration and shared-control suites (22 tests).
- Design typecheck, guards, 93 tests and viewer build passed.
- Emoji, GIF, mention, reaction and composer-format browser journeys passed in
  Chromium and WebKit across focused runs (24 cases). Existing cases were
  retained; no browser cases were added or removed. Failures reproduced before
  fixes covered reaction Escape focus, mention ordering, stale popover roles,
  search geometry and waiting for main's field-border transition to finish.
- The mandatory staged-file format/lint/icon hook passed.
- App typecheck remains blocked by three missing `onOpenLink` test props in
  unchanged main files: `MediaReviewViewer.comments.test.tsx:88`,
  `MessageEdit.integration.test.tsx:288`, and `attachment-panes.test.tsx:230`.
- The additional new-message journey fails in both engines on its expected
  empty `data-placeholder` attribute. Its test, editor and NewMessage owner are
  unchanged from main; the remainder of that journey is not validated here.

Native desktop checks, broad integration checks, hosted CI and review remain
pending. This merge is ready for continued UI iteration, not a release claim.
