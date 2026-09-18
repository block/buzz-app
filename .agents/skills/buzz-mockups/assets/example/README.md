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

Build output goes to this example's ignored `dist/`.

To expand the example, copy it into a task-specific folder and adjust the source paths in its Vite and TypeScript configs. Keep interactions offline; if adding service fixtures, subscription snapshots must remain stable until their data changes.
