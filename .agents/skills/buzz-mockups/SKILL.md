---
name: buzz-mockups
description: Build lightweight, clickable Buzz UI mockups to explore layouts and user flows, not prove backend behavior. Use real components and fake data without starting the full app or connecting to a relay.
---

If you just want to explore what a user flow might look like, you don't need to run the whole Buzz app. You can put together a lightweight, clickable page using the actual Buzz components and styles, with fake data, and run it in the browser.

It's reusing the components, not just recreating their appearance. Interactions can be local state, and any required services can be stubbed out. That lets you sketch the experience without setting up a relay, signing in, or implementing the underlying feature.

There's a [small runnable example with setup notes](assets/example/README.md) if a starting point would help. It uses a real message component with fake data and a local thread toggle.
