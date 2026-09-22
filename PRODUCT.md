# Product

## Register

product

## Users and purpose

Buzz is a place where people build together and bring their agents into the room.
The shared React frontend serves web and desktop conversation workflows. Channels
hold ongoing shared context; shared channel Sessions hold individual pieces of
work using existing threads, not a redesigned agent execution system.

## Posture

Quiet, crisp, functional. Everyday chrome gets out of the way of conversation;
identity and meaningful guidance carry character. Colour is signal, not decoration.
These principles come from the [authoritative design system](src/shared/design-system/DESIGN.md),
not a new brand strategy. Its current local adoption section governs tokens and type.

## Principles and anti-references

- Preserve established product, permission and recipient decisions. Do not infer
  ownership, execution status or notification intent from presentation.
- Prefer flat conversation surfaces and progressive disclosure to nested cards,
  marketing patterns or placeholder actions.
- Reuse the shared components and authored tokens. Keep the existing host theme,
  appearance owner and global navigation; no separate feature-wide visual system.
- For Sessions, inspect the relevant confirmed Figma frames and compare rendered
  screenshots before handoff. Agreed product decisions supersede old placeholders.

## Accessibility and inclusion

Preserve keyboard/pointer equivalence, explicit accessible labels and keyboard-only
focus treatment. Check light and dark modes at narrow, intermediate and wide sizes;
respect reduced motion. Use the design system's contrast and typography roles.

## Sources and scope

- [Design system](src/shared/design-system/DESIGN.md) and
  [maintenance guidance](src/shared/design-system/MAINTAINING_DESIGN_SYSTEM.md).
- [Shared channel Sessions contract and Figma references](docs/sessions.md).
- [Project overview](README.md) and [contribution workflow](docs/contributing.md).

This document records existing repository decisions for design-tool context.
It does not expand the shared Sessions increment or replace private Sessions.
