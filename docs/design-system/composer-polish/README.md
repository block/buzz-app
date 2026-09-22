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
