---
name: buzz-mockups
description: Build lightweight, clickable Buzz UI mockups using real components and fake data, without starting the full app or connecting to a relay.
---

Use this for exploring layouts and user flows, not proving backend behavior. Import existing components and shared styles; keep proposed UI and local interaction state separate from production app code.

Start from [the runnable example](assets/example/main.tsx). It renders the real `MessageRow` with a typed fixture and a local thread toggle. No session is supplied: optional services use the component's own fallback behavior. Media and external navigation are disabled. Prefer this to constructing a fake application session. If another component requires services, inspect its current contract and supply only the needed offline fixtures; external-store snapshots must remain stable until their data changes. Do not connect credentials, the relay, or production write operations merely to render a mockup.

Run from the repository root, using its locked dependencies:

```sh
bin/pnpm install --frozen-lockfile
bin/pnpm exec vite --config .agents/skills/buzz-mockups/assets/example/vite.config.mjs
```

Open the printed HTTP URL, not the HTML file directly. To check and build:

```sh
bin/pnpm exec tsc -p .agents/skills/buzz-mockups/assets/example/tsconfig.json
bin/pnpm exec vite build --config .agents/skills/buzz-mockups/assets/example/vite.config.mjs
```

The example's Vite config resolves Buzz source from the working directory, so keep running it from the repo root. Copy the example into a task-specific folder when expanding it; adjust its TypeScript config paths after moving it. Keep dependencies in the repo rather than introducing a second package manifest. Build output goes to the example's ignored `dist/` and can be hosted statically; publishing requires a separate request.

Check the mockup in a browser: real components should render, demonstrated clicks should work, and no live-service requests or page errors should occur. Clearly distinguish reused components from custom proposed UI. A clickable mockup is not a working implementation of the feature.
