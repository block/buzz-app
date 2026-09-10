# Source attribution

The relay read model in `src/features/relay` and development read broker in `dev`
are adapted from the supplied Astra example. The channel layout
and virtualizer behavior are adapted from that example's Channels view.

Astra's presentation is derived from Block Buzz `prototypes/project-cube-orbit`,
revision `0cd836965110adb18b95747c8656779c470d6e4d`:
https://github.com/block/buzz/tree/0cd836965110adb18b95747c8656779c470d6e4d/prototypes/project-cube-orbit

The Apache-2.0 license is preserved in [LICENSE](LICENSE). Changes here
include Cordis service ownership, scoped channel panels, GitHub reference rendering,
connection lifecycle, stylesheet extraction and integration with the foundation.

App, favicon, and touch icons in `public/` and `src-tauri/icons/` are copied from
Block Buzz's `desktop/src-tauri/icons` ([source repository](https://github.com/block/buzz)).
The shell palette and proportions are adapted from the supplied Buzz screenshots.

`public/bestie.png` is the snake portrait supplied by the user for the shell.

`public/shell-gradient.png` is the background image supplied by Wes for the bento
shell on 2026-09-09 (SHA-256
`618ce821eaea22dd30bddb0c2a933284f0a49f6b4f0cefff5ae0b51e2b3ea651`).
The repeating dots are drawn in CSS, not baked into the image.

The Emoji Mart picker configuration and search-input focus/correction behavior in
`src/features/messages/emoji-mart.ts` are adapted from Block Buzz
`desktop/src/features/custom-emoji/ui/EmojiPicker.tsx` at revision
`b9392d9d78744df365f9276e1ffe8c1baa5ea903`. The adapter adds scoped custom IDs,
explicit dictionary cleanup, and lazy loading for the session-owned catalog.
