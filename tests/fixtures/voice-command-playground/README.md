# Voice & point playground

Run the existing worktree Vite/desktop dev server, then open
`/tests/fixtures/voice-command-playground.html#experience/flow`.

- **Gallery** inventories named states of the spotlight, animated companion,
  composer recording strip and review dialog.
- **Stage** focuses one chosen state; move over specimen elements to point.
- **Compare** keeps two independently interactive fixtures at the chosen width.
- **Flow** starts, records, reviews, discards and simulates sending locally.
  Start demo works without a microphone, or hold Command + Option over the scene.

The inspector uses DialKit 2.2.0 with stable per-component IDs. Controls affect
the real feature visual components. Tuning survives component navigation in
memory; it is not saved to browser storage or applied to the running app.
Use DialKit's versions and copy controls to keep a tuning snapshot. Reset fixtures
resets interaction state, not tuning.

The page imports no authentication or relay session. Recording is a generated
waveform, playback is a local test tone, and screenshots use labelled sample images.
“Send” is simulated. Review dialogs
use the real viewport portal, with the same focus and dismissal as the app.
Theme, viewport and enlarged text controls belong to the neutral playground shell.

Production visuals live in `src/features/voice-command/VoiceCommandVisuals.tsx`;
capture and delivery remain in `use-point-and-speak.ts` and `BestieVoiceCommand.tsx`.
