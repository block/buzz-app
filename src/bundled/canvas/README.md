# Canvas

Show web pages, maps, video and other views beside a conversation, and look at
them together. Canvas is bundled with Buzz and off by default. Enable it in
**Settings → Plugins → Manage plugins**.

## Getting started

Choose **Share a view** in a channel's menu to open its canvas, then add a
view. Everyone in the conversation sees the same views.

**Take control** makes you the driver: what you open, switch to or change is
what followers see. Others follow you by default. **Stop following** lets
someone look around alone without changing anything for anyone else, and
**Follow** brings them back to what the driver is showing. With nobody driving,
any member's change is shared.

Agents use `canvas_read`, `canvas_open`, `canvas_update`, `canvas_close` and
`canvas_drive`. An agent reads a description of each view, never the picture.

A canvas is saved in its conversation, so its members and the relay operator
can read it. It is not end-to-end encrypted. Saving requires a community that
supports shared records.

---

## View types

The canvas itself knows nothing about browsers or maps. Each kind of view is a
registration with the `canvasViews` service: a `type`, a `parse` that validates
untrusted state, a `describe` that tells an agent what the view shows, and a
component that renders from `state` alone. A plugin that injects `canvasViews`
can add its own.

A scene is one shared record (NIP-AR kind 45010, type `buzz.canvas`) per
conversation: `{ version: 1, items: [{ id, type, title?, state }], active?, driver? }`.
`driver` is presentation, not permission; the relay decides who may write.
Following is each viewer's own choice and is never saved.
