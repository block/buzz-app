# OS deep links

Desktop builds register a URL scheme with the operating system through
`tauri-plugin-deep-link`, with `tauri-plugin-single-instance` registered ahead of it
so a second launch hands its URL to the running app instead of opening another
window. The browser build has no OS ingress and keeps its `#buzz=` address form.

## The scheme

While this work is in development the registered scheme is `buzz-app`, so that a
machine with the released Buzz installed routes test links to this app rather than
to Buzz. It becomes `buzz` before release.

In-app links keep the `buzz://` scheme regardless. **Copy link** still produces
`buzz://open?target=…`, messages still recognize `buzz://channel/<id>` and
`buzz://message?…`, and the original Buzz client can still read what this app
shares. The OS ingress accepts those same address forms under the registered scheme
and nothing else: `buzz-app://channel/general` opens what `buzz://channel/general`
opens inside a message. To test a copied link from the OS, replace its `buzz://`
prefix with `buzz-app://`.

## Accepted links

- `buzz-app://open?target=…`: the versioned locator that **Copy link** produces (as
  `buzz://open?target=…`). It carries its own community; the signed-in viewer is
  bound on receipt.
- `buzz-app://message?channel=<id>&id=<event>[&thread=<root>]` and
  `buzz-app://channel/<id>`: legacy forms that carry no community. They bind to the
  currently selected community and viewer.

Every other link, including `buzz-app://join`, `buzz-app://pr`, unknown hosts and
oversize links, fails as `invalid-target` and shows "This destination couldn't
open" with **Retry navigation** and **Go Home**. Nothing is dropped silently and
nothing is auto-joined. A valid address is never authorization: bound targets pass
the same viewer, membership and channel checks as in-app navigation, so a shared
link into a community you have not joined still fails `denied`.

## How a link travels

1. The shell accepts URLs whose scheme is exactly the registered one and logs and
   drops anything else, upper-case variants included. Accepted URLs enter a
   32-entry queue (oldest evicted first) and the main window is foregrounded, as
   notification clicks already do.
2. On startup the webview drains the queue and registers a channel that is pinged
   with the queue depth when more arrive; every ping drains again. Only raw URL
   strings cross the boundary. All parsing lives in
   `src/features/navigation/deep-links.ts`, which maps the registered scheme onto
   the in-app `buzz:` form and hands it to the navigation target parser, so that
   parser stays the single gate.
3. Held links wait until the communities service leaves `loading`, then run in
   arrival order. Legacy links fail `unavailable` when no community is selected or no
   identity is known; shared links with a community need an identity; unscoped
   shared links (Home, Settings) open at once.
4. Cold start: macOS delivers the URL as a run event once the app is up; Windows and
   Linux receive it as the process argument, which the plugin parses at startup. In
   both cases the queue holds it until the webview asks, so the app opens at Home
   and then moves to the destination.

The webview holds no `deep-link:*` capability: Rust owns the plugin, and the two app
commands are main-window only. The opener capability is unchanged; neither `buzz:`
nor `buzz-app:` is ever handed to the OS opener, and in-message `buzz://` clicks
keep their existing path.

## Testing locally

Copy a link from a message's **Copy link** action and replace `buzz://` with
`buzz-app://`, or write one by hand, such as `buzz-app://channel/general` or
`buzz-app://message?channel=general&id=<64-hex event id>`. A warm app should come to
the front and open the conversation. A cold start should launch, show Home, then
open the destination once the client is ready. A malformed link such as
`buzz-app://join?relay=example` must show the failure notice. A plain
`buzz://channel/general` still goes to whichever app owns `buzz`, which is the point.

**macOS** only routes a scheme to a bundled app. `just desktop` binaries are never
registered, so build a debug bundle and launch it once to register it with Launch
Services:

```sh
bin/pnpm tauri build --debug --bundles app
open "target/debug/bundle/macos/Buzz Foundation.app"
open "buzz-app://channel/general"
```

Quit the app and run the last command again to test a cold start. The bundle lands
under the workspace `target/` directory because `src-tauri` is a workspace member.

**Windows** registers the launching binary for `buzz-app://` under the current user
on every start, so a `pnpm tauri dev` build works without an installer:

```powershell
start buzz-app://channel/general
```

The NSIS installer registers the installed app as well; whichever build launched
most recently owns the scheme.

**Linux** writes a `<binary>-handler.desktop` entry and calls `xdg-mime` and
`update-desktop-database` on every start, so both must be installed. Packaged
`.deb` and AppImage builds also declare `x-scheme-handler/buzz-app` in their desktop
entry.

```sh
xdg-open "buzz-app://channel/general"
```

## Current limits

- The registered scheme is the development one, `buzz-app` (see
  [The scheme](#the-scheme)). It must return to `buzz` before release.
- Invite links (`buzz://join`, `https://<relay>/invite/<code>`), entity links
  (`buzz://repo`, `buzz://pr`, …) and remote push are not handled; they end in the
  failure notice or, for HTTPS, never reach the app.
- A link that fails, including one that arrived before a community was selected, is
  not kept for automatic retry. **Retry navigation** re-runs the current visit.
- Only the main window receives links. Release signing and distribution remain
  unconfigured; a locally built bundle is enough to exercise scheme registration.
