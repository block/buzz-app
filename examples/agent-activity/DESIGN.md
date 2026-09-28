# Visual direction

Use ../../src/shared/design-system/DESIGN.md and shared components as the source
of truth. This prototype introduces no new system tokens or component variants.

Use quiet action rows and progressive disclosure from the shared design system.

Restrained semantic neutrals; existing Buzz backdrop and opaque Panel surfaces.
Inter for prose and action labels; JetBrains Mono only for actual commands/output.
Whitespace and alignment separate steps, not nested cards or timeline ornaments.

Scene: a person works through an agent response in a light Buzz desktop workspace,
with a channel and its thread already visible, checking progress without leaving
the conversation. Activity should feel like part of that conversation.

Four interactive states: compact working; inline activity with expandable detail;
optional extra side panel; completed response with View activity above its text.
Synthetic data is explicitly labelled. User-driven controls change states; no
fake background timers, private profile data, or live services.
