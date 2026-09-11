# Design system handoff

This shared system is staged for adoption; it does not style the running app yet.
Read DESIGN.md and MAINTAINING_DESIGN_SYSTEM.md before editing.
Use authored ramps and named type roles; keep Base UI behavior and Tabler icons.
Preserve keyboard-only focus and test light/dark and narrow/intermediate/wide views.
Components live in ui/, values in styles/, documentation metadata in tokens/ and ui/registry.ts.
The standalone viewer lives in tests/fixtures/design-system and imports the real shared components.
Do not import features, plugins, native adapters, or app startup into this system or viewer.
Do not import its globals into the app until the separate compatibility/adoption work is approved.
The theme helper is viewer-only during staging; app adoption must keep the host appearance owner.
Run the root design:typecheck, design:check, design:test, and design:build scripts.
