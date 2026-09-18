# Runnable Buzz mockup

[main.tsx](main.tsx) assembles the real `AppShell`, `MessageRow`, and `MessageComposer` around a channel and task thread. This is one scene, not a working app: service fixtures replace the backend, and sending is blocked. The task card and layout are custom mockup UI.

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
