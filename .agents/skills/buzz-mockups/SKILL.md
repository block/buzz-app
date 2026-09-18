---
name: buzz-mockups
description: Build lightweight, clickable Buzz UI mockups to explore layouts and user flows, not prove backend behavior. Use real components and fake data without starting the full app or connecting to a relay.
---

Build a standalone browser page from existing Buzz components and shared styles. Supply fake data through component props and use local state for click-through interactions; keep the mockup separate from production app code.

Inspect the components' current contracts. Prefer optional-service fallbacks; when services are required, provide minimal offline fixtures with stable subscription snapshots. Do not start the full app or connect credentials, relay services, or production writes just to render the mockup.

Reuse the repository's dependencies and keep custom styling focused on the proposed UI. Check the page in a browser: components should render, intended clicks should work, and there should be no page errors or live-service requests. Distinguish existing UI from proposed behavior when sharing it; hosting or posting requires a separate request.

Optional: consult [the runnable example and setup notes](assets/example/README.md) for a minimal starting point using a real message component and a local thread toggle.
