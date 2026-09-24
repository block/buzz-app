# OS deep links

Desktop builds register `buzz` as a URL scheme with the operating system through
`tauri-plugin-deep-link`, with `tauri-plugin-single-instance` registered ahead of it
so a second launch hands its URL to the running app instead of opening another
window. The browser build has no OS ingress and keeps its `#buzz=` address form.

## Accepted links

- `buzz://open?target=…`: the versioned locator that **Copy link** produces. It
  carries its own community; the signed-in viewer is bound on receipt.
- `buzz://message?channel=<id>&id=<event>[&thread=<root>]` and
  `buzz://channel/<id>`: legacy forms that carry no community. They bind to the
  currently selected community and viewer.

Every other `buzz://` link, including `buzz://join`, `buzz://pr`, unknown hosts and
oversize links, fails as `invalid-target` and shows "This destination couldn't
open" with **Retry navigation** and **Go Home**. Nothing is dropped silently and
nothing is auto-joined. A valid address is never authorization: bound targets pass
the same viewer, membership and channel checks as in-app navigation, so a shared
link into a community you have not joined still fails `denied`.

## How a link travels

1. The shell accepts URLs whose scheme is exactly `buzz` and logs and drops
   anything else. Accepted URLs enter a 32-entry queue (oldest evicted first) and
   the main window is foregrounded, as notification clicks already do.
2. On startup the webview drains the queue and registers a channel that is pinged
   with the queue depth when more arrive; every ping drains again. Only raw URL
   strings cross the boundary. All parsing lives in
   `src/features/navigation/deep-links.ts`, so the navigation target parser stays
   the single gate.
3. Held links wait until the communities service leaves `loading`, then run in
   arrival order. Legacy links fail `unavailable` when no community is selected or no
   identity is known; shared links with a community need an identity; unscoped
   shared links (Home, Settings) open at once.
4. Cold start: macOS delivers the URL as a run event once the app is up; Windows and
   Linux receive it as the process argument, which the plugin parses at startup. In
   both cases the queue holds it until the webview asks, so the app opens at Home
   and then moves to the destination.

The webview holds no `deep-link:*` capability: Rust owns the plugin, and the two app
commands are main-window only. The opener capability is unchanged; `buzz:` is never
handed to the OS opener, and in-message `buzz://` clicks keep their existing path.

## Testing locally

Copy a link from a message's **Copy link** action, or write one by hand, such as
`buzz://channel/general` or `buzz://message?channel=general&id=<64-hex event id>`.
A warm app should come to the front and open the conversation. A cold start should
launch, show Home, then open the destination once the client is ready. A malformed
link such as `buzz://join?relay=example` must show the failure notice.

**macOS** only routes a scheme to a bundled app. `just desktop` binaries are never
registered, so build a debug bundle and launch it once to register it with Launch
Services:

```sh
bin/pnpm tauri build --debug --bundles app
open "target/debug/bundle/macos/Buzz Foundation.app"
open "buzz://channel/general"
```

Quit the app and run the last command again to test a cold start. The bundle lands
under the workspace `target/` directory because `src-tauri` is a workspace member.

**Windows** registers the launching binary for `buzz://` under the current user on
every start, so a `pnpm tauri dev` build works without an installer:

```powershell
start buzz://channel/general
```

The NSIS installer registers the installed app as well; whichever build launched
most recently owns the scheme.

**Linux** writes a `<binary>-handler.desktop` entry and calls `xdg-mime` and
`update-desktop-database` on every start, so both must be installed. Packaged
`.deb` and AppImage builds also declare `x-scheme-handler/buzz` in their desktop
entry.

```sh
xdg-open "buzz://channel/general"
```

## Current limits

- Invite links (`buzz://join`, `https://<relay>/invite/<code>`), entity links
  (`buzz://repo`, `buzz://pr`, …) and remote push are not handled; they end in the
  failure notice or, for HTTPS, never reach the app.
- A link that fails, including one that arrived before a community was selected, is
  not kept for automatic retry. **Retry navigation** re-runs the current visit.
- Only the main window receives links. Release signing and distribution remain
  unconfigured; a locally built bundle is enough to exercise scheme registration.
