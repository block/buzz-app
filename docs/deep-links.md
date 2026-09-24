# OS deep links

Desktop builds register a URL scheme with the operating system, so a link opened
outside the app brings it to the front and navigates, at cold start too. Every build
registers `buzz://`, the same scheme in-app links and **Copy link** use; `just desktop`
and `just desktop-bundle` claim it like a released build does. Builds share this
scheme (see [current limits](#current-limits)). The browser build has no OS ingress
and keeps its `#buzz=` address form.

## Accepted links

The OS ingress accepts the Buzz link forms and nothing else:

- `buzz://message?channel=<id>&id=<event>[&thread=<root>]`
- `buzz://channel/<id>`
- `buzz://channel/<id>/<event>` (the original desktop message alias)
- `buzz://repo?owner=<64-hex key>&d=<identifier>[&tab=<section>]`
- `buzz://project?owner=<64-hex key>&d=<identifier>[&tab=<section>]`
- `buzz://pr?id=<64-hex event>&owner=<64-hex key>&d=<repository>`
- `buzz://issue?id=<64-hex event>&owner=<64-hex key>&d=<repository>`

Entity sections are `files`, `commits`, `issues`, `prs`, `contributors`, and
`channels`; omitting the section opens the overview. Repository commit links add
`&tab=commits&commit=<40- or 64-hex hash>`. Identifiers use 1-64 ASCII letters,
digits, `_`, `-`, or `.`, without a leading dot or `..`. Unknown or duplicate
parameters are rejected. The same forms work in message content.

None carries a community, so each binds to the currently selected community and
viewer, and fail `unavailable` when no community is selected or no identity is
known. Every other link, including `buzz://open?target=…`, `buzz://join`,
incomplete entity links, unknown hosts, case variants of the scheme and oversize links, fails as
`invalid-target` and shows "This destination couldn't open" with
**Open Settings**. Unsupported links have no Retry action. Nothing is
auto-joined. A valid address is never authorization: bound targets pass the same
viewer, membership and channel checks as in-app navigation, so a link into a channel
you cannot read still fails `denied`.

The latest arriving link wins. Before readiness, one pending intent is retained;
if identity or community is missing, select a community and use **Retry navigation**.
The first known viewer and community bind the intent: switching either afterward
cannot reinterpret it. New navigation cancels it. A cold start opens the ordinary
start page before the destination.

Projects owns entity presentation and acknowledges navigation after the requested
content is ready. Repository/project overviews, files, commit history and selected
diffs, issue/PR details and discussion, contributors, and linked channels are real
read-only destinations. Project Git sections name their primary repository
(matching identifier, otherwise the first coordinate) and link to other members.
Signed entity metadata remains visible independently of linked-channel access;
Git reads still enforce the relay's authorization. Missing entities and failed
explicit Git sections report navigation failure, not an empty successful page.

**Copy link** emits `buzz://message`, including a reply's thread root when known.
This deliberately omits the sender's community and identity: recipients must select
the correct community before opening it. Original mobile Buzz requires a UUID
channel identifier; named development channels are supported here but do not imply
mobile compatibility. Existing `buzz://open` locators still preserve community
context for in-app use and remain unsupported at the OS boundary.

## Testing locally

Write a link by hand, such as `buzz://channel/general` or
`buzz://message?channel=general&id=<64-hex event id>`. A warm app should come to the
front and open the conversation. A cold start should launch, show the start page, then open the
destination once the client is ready. A malformed link such as
`buzz://join?relay=example` must show the failure notice.

For entity destinations, use `just web` with the existing authenticated development
broker, select the owning community, and open Projects or a Buzz entity link in a
message. No publication is needed to browse. The broker requires Git on its PATH;
it signs repository-root NIP-98 reads with the existing host identity. A selected
commit must show that exact revision and its diff. Back/Forward and Copy link
preserve the entity route, including the requested tab and commit.

**macOS** only routes a scheme to a bundled app. `just desktop` binaries are never
registered, so build a debug bundle and launch it once to register it with Launch
Services:

```sh
just desktop-bundle
open "target/debug/bundle/macos/Buzz Foundation.app"
open "buzz://channel/general"
```

Quit the app and run the last command again to test a cold start. The bundle lands
under the workspace `target/` directory because `src-tauri` is a workspace member.

**Windows** registers the launching binary under the current user on every start, so
a `just desktop` build works without an installer:

```powershell
start buzz://channel/general
```

The NSIS installer registers the installed app as well; whichever build launched
most recently owns the scheme.

**Linux** writes a `<binary>-handler.desktop` entry and calls `xdg-mime` and
`update-desktop-database` on every start, so both must be installed. Packaged `.deb`
and AppImage builds also declare the scheme in their desktop entry.

```sh
xdg-open "buzz://channel/general"
```

## Current limits

- Development builds register `buzz` like released ones, so on a machine with Buzz
  installed the two compete for it: Windows and Linux route it to whichever binary
  started last, and macOS to whichever registered bundle Launch Services picks.
- Every local bundle keeps the same application identifier, so they share app data
  and Launch Services lists several bundles under one identifier.
- Invite links (`buzz://join`, `https://<relay>/invite/<code>`) and remote push
  are not handled; they end in the
  failure notice or, for HTTPS, never reach the app.
- Git browsing currently uses the authenticated development broker, not packaged
  desktop transport. Other adapters can still show entity metadata; explicit Git
  sections report unavailable. No repository editing, issue changes, PR review
  decisions, or merge operations are included.
- Git reads fetch a fresh shallow repository per demand: latest 100 commits,
  20,000 file entries, 1 MiB text files and a 4 MiB response ceiling. The 12-second
  deadline and two-read concurrency bound work, not downloaded pack bytes/disk.
  Very large repositories may fail. Empty repositories show no files/commits;
  requesting a specific absent revision still fails. Discovery and issue/PR lists show at most 100 events;
  activity exceeding the 500-event safety bound reports unavailable. These are
  finite views, not exhaustive analytics. Project member resolution is bounded to
  64 members. Valid metadata identifiers outside Buzz's link grammar remain visible
  but cannot be opened/shared through these routes.
- Only the main window receives links. Release signing and distribution remain
  unconfigured; a locally built bundle is enough to exercise scheme registration.
