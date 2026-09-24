# OS deep links

Desktop builds register a URL scheme with the operating system, so a link opened
outside the app brings it to the front and navigates, at cold start too. The
registered scheme is `buzz-app` while this work is in development (see
[current limits](#current-limits)); in-app links, including what **Copy link**
produces, stay `buzz://` either way, so a copied link needs its prefix replaced by
hand. The browser build has no OS ingress and keeps its `#buzz=` address form.

## Accepted links

The OS ingress accepts the address forms an in-app link uses and nothing else:

- `buzz-app://open?target=…`, the versioned locator that **Copy link** produces. It
  carries its own community; the signed-in viewer is bound on receipt.
- `buzz-app://message?channel=<id>&id=<event>[&thread=<root>]` and
  `buzz-app://channel/<id>`, legacy forms that carry no community. They bind to the
  currently selected community and viewer, and fail `unavailable` when no community
  is selected or no identity is known.

Every other link, including `buzz-app://join`, `buzz-app://pr`, unknown hosts,
case variants of the scheme and oversize links, fails as `invalid-target` and shows
"This destination couldn't open" with **Retry navigation** and **Go Home**. Nothing
is dropped silently and nothing is auto-joined. A valid address is never
authorization: bound targets pass the same viewer, membership and channel checks as
in-app navigation, so a shared link into a community you have not joined still
fails `denied`.

Links that arrive before the client is ready are held rather than lost, then opened
in arrival order once the communities service has loaded. A link delivered at cold
start therefore opens Home first and its destination after.

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

- The registered scheme is the development one, `buzz-app`, so that a machine with
  the released Buzz installed routes test links to this app rather than to Buzz. It
  must return to `buzz` before release. Shared links and the original Buzz client
  are unaffected: **Copy link** produces `buzz://open?target=…` either way.
- Invite links (`buzz://join`, `https://<relay>/invite/<code>`), entity links
  (`buzz://repo`, `buzz://pr`, …) and remote push are not handled; they end in the
  failure notice or, for HTTPS, never reach the app.
- A link that fails, including one that arrived before a community was selected, is
  not kept for automatic retry. **Retry navigation** re-runs the current visit.
- Only the main window receives links. Release signing and distribution remain
  unconfigured; a locally built bundle is enough to exercise scheme registration.
