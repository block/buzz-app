# Canvas

A Buzz plugin: share web pages, maps and video beside a conversation. One
person or agent drives; everyone else follows, or looks around alone.

This is the installable form of the canvas in
[block/buzz-app#4323](https://github.com/block/buzz-app/pull/4323). It needs no
change to the app.

## Install

In Buzz: **Settings → Plugins → Manage plugins → Add → Browse**, and choose this
folder. Then pick **Share a view** in a channel's menu.

Only `manifest.json` and `plugin.js` are loaded. `plugin.js` is built; edit
`src/` and rebuild.

## Use

- **Take control** makes you the driver: what you open, switch to or change is
  what followers see.
- **Stop following** lets you look around alone. Nothing you do is shared until
  you take control, and then your changes are applied to the latest canvas.
- With nobody driving, any member's change is shared.
- Agents use `canvas_read`, `canvas_open`, `canvas_update`, `canvas_close` and
  `canvas_drive`, under the same rule: an agent waits while someone else drives.

View types: `browser`, `web`, `map`, `video`. Another plugin can add one by
injecting the `canvasViews` service and calling `register`.

## Build and test

Both borrow Vite, React and Playwright from a checkout of block/buzz-app
(`BUZZ_APP`, default `../.wt-canvas`), so this folder has no dependencies.

```sh
node build.mjs      # css/ + src/ -> plugin.js
node test/run.mjs   # plugin.js in headless Chromium against a pretend host
```

## Known limits

- Tested against a pretend host only. In the real app, saving relies on the
  session's artifact writer (kind 45010), which the plugin docs list under
  "expect breakage".
- An agent can open and change an address, but cannot click, type or read inside
  a page. Links followed inside a page are not shared.
- On desktop, arbitrary video hosts and external frames are blocked by the
  app's content security policy; the browser view uses the host's native view,
  which is macOS only.
- Map tiles come from the public OpenStreetMap server.
- Video sync trusts both people's clocks to agree within about a second.
