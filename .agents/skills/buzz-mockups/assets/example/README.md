# Runnable Buzz mockup

[main.tsx](main.tsx) renders the real `MessageRow` with a typed fixture and a local thread toggle. No session is supplied: optional services use the component's own fallback behavior. Media and external navigation are disabled.

## Run

From the repository root, using its locked dependencies:

```sh
bin/pnpm install --frozen-lockfile
bin/pnpm exec vite --config .agents/skills/buzz-mockups/assets/example/vite.config.mjs
```

Open the printed HTTP URL, not the HTML file directly. To check and build:

```sh
bin/pnpm exec tsc -p .agents/skills/buzz-mockups/assets/example/tsconfig.json
bin/pnpm exec vite build --config .agents/skills/buzz-mockups/assets/example/vite.config.mjs
```

Build output goes to this example's ignored `dist/` and can be hosted statically. Publishing requires a separate request.

## Adapt

Copy the example into a task-specific folder when expanding it; adjust its TypeScript config paths after moving it. The Vite config resolves Buzz source from the working directory, so keep running it from the repo root. Reuse the repo's dependencies rather than introducing a second package manifest.

Prefer optional-service fallbacks to constructing a fake application session. If another component requires services, inspect its current contract and supply only the needed offline fixtures; external-store snapshots must remain stable until their data changes. Do not connect credentials, the relay, or production write operations merely to render a mockup.

Check in a browser that components render, demonstrated clicks work, and no live-service requests or page errors occur. Distinguish reused components from custom proposed UI: this demonstrates a flow, not a working backend implementation.
