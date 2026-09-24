# OS deep links

Desktop builds register a URL scheme with the operating system, so a link opened
outside the app brings it to the front and navigates, at cold start too. Released
builds register `buzz://`, the same scheme in-app links and **Copy link** use.
`just desktop` and `just desktop-bundle` instead claim a scheme of their own, derived
from the worktree path and printed at startup, so a machine with the released Buzz
installed still routes test links here (see [current limits](#current-limits)). The
browser build has no OS ingress and keeps its `#buzz=` address form.

## Accepted links

The OS ingress accepts the Buzz link forms and nothing else:

- `buzz://message?channel=<id>&id=<event>[&thread=<root>]`
- `buzz://channel/<id>`

Neither carries a community, so both bind to the currently selected community and
viewer, and fail `unavailable` when no community is selected or no identity is
known. Every other link, including `buzz://open?target=…`, `buzz://join`,
`buzz://pr`, unknown hosts, case variants of the scheme and oversize links, fails as
`invalid-target` and shows "This destination couldn't open" with
**Retry navigation** and **Go Home**. Nothing is dropped silently and nothing is
auto-joined. A valid address is never authorization: bound targets pass the same
viewer, membership and channel checks as in-app navigation, so a link into a channel
you cannot read still fails `denied`.

Links that arrive before the client is ready are held rather than lost, then opened
in arrival order once the communities service has loaded. A link delivered at cold
start therefore opens Home first and its destination after.

## Testing locally

Use the scheme the launch printed; `buzz-dev-3fa9c1` stands in for it below. Write a
link by hand, such as `buzz-dev-3fa9c1://channel/general` or
`buzz-dev-3fa9c1://message?channel=general&id=<64-hex event id>`. A warm app should
come to the front and open the conversation. A cold start should launch, show Home,
then open the destination once the client is ready. A malformed link such as
`buzz-dev-3fa9c1://join?relay=example` must show the failure notice. A plain
`buzz://channel/general` goes to whichever app owns `buzz`, which is the point.

**macOS** only routes a scheme to a bundled app. `just desktop` binaries are never
registered, so build a debug bundle and launch it once to register it with Launch
Services:

```sh
just desktop-bundle
open "target/debug/bundle/macos/Buzz Foundation.app"
open "buzz-dev-3fa9c1://channel/general"
```

Quit the app and run the last command again to test a cold start. The bundle lands
under the workspace `target/` directory because `src-tauri` is a workspace member.

**Windows** registers the launching binary under the current user on every start, so
a `just desktop` build works without an installer:

```powershell
start buzz-dev-3fa9c1://channel/general
```

The NSIS installer registers the installed app as well; whichever build launched
most recently owns the scheme.

**Linux** writes a `<binary>-handler.desktop` entry and calls `xdg-mime` and
`update-desktop-database` on every start, so both must be installed. Packaged `.deb`
and AppImage builds also declare the scheme in their desktop entry.

```sh
xdg-open "buzz-dev-3fa9c1://channel/general"
```

## Current limits

- Development builds do not register `buzz`, so they cannot be used to check that a
  link produced elsewhere opens Buzz itself. Both `just desktop` and
  `just desktop-bundle` accept `--scheme buzz` to claim the real one, at the cost of
  clashing with any installed Buzz.
- **Copy link** still produces `buzz://open?target=…`, this app's in-app locator
  rather than a Buzz link. Opened outside the app it ends in the failure notice;
  only `buzz://message` and `buzz://channel` links open from the OS.
- Every worktree bundle keeps the same application identifier, so they share app
  data and Launch Services lists several bundles under one identifier. Scheme
  lookup is by scheme, so links still route unambiguously.
- Invite links (`buzz://join`, `https://<relay>/invite/<code>`), entity links
  (`buzz://repo`, `buzz://pr`, …) and remote push are not handled; they end in the
  failure notice or, for HTTPS, never reach the app.
- A link that fails, including one that arrived before a community was selected, is
  not kept for automatic retry. **Retry navigation** re-runs the current visit.
- Only the main window receives links. Release signing and distribution remain
  unconfigured; a locally built bundle is enough to exercise scheme registration.
