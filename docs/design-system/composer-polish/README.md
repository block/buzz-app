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
