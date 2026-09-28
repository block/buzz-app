# Agent activity visual prototype

## Register

product

## Users

People collaborating with agents in Buzz channels and threads. A person may
already have a channel and thread open and wants to understand the selected
agent's current work without being forced into an additional pane.

## Product Purpose

Make existing selected-agent activity readable and easy to inspect in context.
This is an isolated interactive visual prototype with synthetic data, not a live
telemetry, runtime, or persistence implementation.

## Brand Personality

Airy, quiet, clear. The conversation remains primary. The user explicitly asked
for the new Buzz design system, a light feel, and no excessive UI or redundant
containers. Prioritize the light desktop composition, while respecting existing
dark tokens, readable contrast, keyboard focus, text zoom, and narrower layouts.

## Anti-references

No nested cards around activity, raw log as the primary view, dashboard metrics,
repeated identity on every tool row, automatic extra panels, invented progress,
or assistant-specific content. Preserve the shared palette and icon library.

## Design Principles

- Use Buzz's existing shared components and semantic roles. Its visual source of
  truth is ../../src/shared/design-system/DESIGN.md.
- Use quiet action rows and progressive disclosure.
- Click consistently expands inline during and after work. Drag-out is opt-in,
  adds a side pane without removing the thread, and collapses inline details.
- Compact status shows the latest available action, falling back to Working only
  with fresh working evidence. View activity remains above the completed reply.
- Preserve current selected-agent/channel scope and bounded live-only retention.

## Accessibility & Inclusion

Shared Base UI behavior; keyboard-only focus visibility; non-drag alternative for
panel opening; labelled controls; no color-only state; reduced-motion support.
Use Buzz semantic text roles and existing light/dark contrast decisions, not
private sizes or faded text. Keep reading and controls usable at narrow widths.
