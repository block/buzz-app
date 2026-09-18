# Lightweight task-workspace mockup

A standalone browser presentation using real Buzz components with fictional data. It does not start the application, connect to a relay, or load credentials. Sending messages throws rather than publishing. This is a user-flow exploration, not a working Tasks feature or supported component SDK.

From the repository root:

```sh
bin/pnpm install --frozen-lockfile
bin/pnpm exec vite --config examples/task-workspace-mockup/vite.config.mjs
```

Open the URL printed by Vite. Use the bottom-right selector to switch among the four scenes: thread plus task, task viewer with branch discussion, dedicated task channel, and project viewer. The restricted-access toggle is illustrative; it does not enforce real permissions.

To build a statically hostable copy:

```sh
bin/pnpm exec vite build --config examples/task-workspace-mockup/vite.config.mjs
bin/pnpm exec vite preview --config examples/task-workspace-mockup/vite.config.mjs
```

Publish the generated `examples/task-workspace-mockup/dist` directory to an appropriate static host. Built assets are not committed.

## How it works

`main.tsx` imports the actual AppShell, MessageRow, MessageComposer, channel CSS, and global styles from this checkout. Small fixture objects supply only the service interfaces these views need. Navigation and disclosures use local React/browser state. Branch links are presentation placeholders, and Request access only changes a local label.

The task cards, headers, references, context rail, and project list are custom proposed UI. The sidebar reuses channel-list CSS with fixture markup. This is not a claim of full design-system compliance. Source imports are internal and can require adjustment as the app evolves.

The original published concept demo is available to Block employees at https://blockcell.sqprod.co/sites/buzz-task-workspaces-jtennant/ . This source copy uses the components from this branch; it is not a byte-identical archive of that older deployment.
