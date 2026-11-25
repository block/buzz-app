# Canvas

A Buzz plugin: share web pages, maps and video beside a conversation. One
person or agent drives; everyone else follows, or looks around alone.

This is the installable form of the canvas in
[block/buzz-app#4323](https://github.com/block/buzz-app/pull/4323). It needs no
change to the app.

## Install

You need the Buzz desktop app. Nothing to build: `plugin.js` is checked in.

```sh
git clone --single-branch -b wintermute/canvas-plugin-installable \
  https://github.com/block/buzz-app.git buzz-canvas-plugin
```

In Buzz: **Settings → Plugins → Manage plugins → Add → Browse**, and choose the
`buzz-canvas-plugin` folder. Plugins run with the app's full access, so Buzz
asks you to confirm.

To open the canvas:

- in a channel, pick **Share a view** in the channel's menu;
- in a Solo chat, use the canvas button in the chat's header.

To update, `git pull` in the folder, then reload the plugin in the same
settings page. To test together, everyone in the conversation needs the plugin
installed.

Only `manifest.json` and `plugin.js` are loaded. `plugin.js` is built; edit
`src/` and rebuild.

## Use

- Each view is a tab in the strip above the panel. The **+** beside the tabs
  adds a view, goes to one whose tab you closed, or removes the current view
  for everyone. A tab's × closes it for you only.
- The **steering wheel** at the end of the address row takes control: what you
  open, switch to or change is what followers see. Click it again to stop.
- The **eye** appears while someone else drives. It switches between following
  them and looking around alone. Nothing you do alone is shared until you take
  control, and then your changes are applied to the latest canvas.
- With nobody driving, any member's change is shared.
- In a browser view, the address you type and the links you follow are shared.
- Agents use `canvas_read`, `canvas_open`, `canvas_update`, `canvas_close` and
  `canvas_drive`, under the same rule: an agent waits while someone else drives.

View types: `browser`, `web`, `map`, `video`. Another plugin can add one by
injecting the `canvasViews` service and calling `register`.

## Build and test

Both borrow Vite, React and Playwright from a checkout of block/buzz-app
with its dependencies installed, so this folder has none of its own. Point
`BUZZ_APP` at that checkout (default `../.wt-canvas`).

```sh
node build.mjs      # css/ + src/ -> plugin.js
node test/run.mjs   # plugin.js in headless Chromium against a pretend host
```

## Known limits

- The automated tests run against a pretend host. In the real app, saving and
  agent tools have been used on a live relay; following between two people has
  not been tried yet.
- Saving relies on the session's artifact writer (kind 45010), which the plugin
  docs list under "expect breakage".
- The plugin reaches into the host's markup in two places: it reads the browser
  view's address bar to share navigation, and it puts the **+** into the tab
  strip. A change to either in the app can break that part.
- An agent can open and change an address, but cannot click, type or read inside
  a page.
- A link followed in the first four seconds after a page opens is treated as a
  redirect and not shared.
- On desktop, arbitrary video hosts and external frames are blocked by the
  app's content security policy; the browser view uses the host's native view,
  which is macOS only.
- Map tiles come from the public OpenStreetMap server.
- Video sync trusts both people's clocks to agree within about a second.
