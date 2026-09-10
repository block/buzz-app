# Plugin architecture

## Purpose

Buzz should make it practical for people and agents to build new product experiences with code. A designer should be able to build an experimental Channels page using real data and useful components, without implementing relay operations. A developer experience team should be able to add rich integrations to conversations without owning the surrounding application. And end customers of buzz should be able to extend the installed app dynamically, without having to contribute upstream or run the dev server.

Plugins are the unit of contribution and installation. They can contain substantial implementations: several components, their own layout and interactions, and multiple contributions. The foundation is ordinary React components, shared data and execution capabilities, and a small number of explicit extension points.

## The first two authoring experiences

**A page (target authoring experience).** A builder creates a plugin that registers
a page, reads shared channel views, and builds a new interface. They should be able
to reuse timeline/message components or build their own, owning the complete page
implementation and its behavior and appearance. Bundled source demonstrates this
composition today; supported external imports/component reuse remain an
[author-contract gate](status.md#open-acceptance-and-product-gates).

**Rich conversation content.** An integration plugin recognizes a link to a GitHub pull request or a native Buzz object and supplies a panel showing that object. The Channels page decides where the panel appears. Another page can display the same content in a different arrangement.

Both experiences use real session capabilities. As AI integrations become available, authors should be able to consume those capabilities without rebuilding authentication, execution, or state handling. The first [Agents slice](agents.md) shows the existing Buzz library read-only; mentions use current channel membership and existing runners.

## Ownership

| Area | Responsibility |
| --- | --- |
| Application host | Startup, plugin installation and activation, page navigation, Settings, and recovery. |
| Page plugin | Its complete React tree, local interaction state, internal navigation, and arrangement of panels. |
| Panel plugin | Recognizing a supported target and implementing the content and interactions for that target. |
| Shared capabilities | Session state, relay access, retained data, and eventually agent operations and external connections. |
| Reusable UI components | Useful rendering and interaction behavior, configured through ordinary props. |
| Cordis | Dependency availability and resource lifetime across plugin activation, replacement, and disposal. |

Bundled and local plugins use the same contribution contracts. Within the source
tree, shared implementation code remains importable without another registration
layer; this is not a promise that external artifacts can import host source paths.


## Code arrangement

```text
app/                    host, startup, navigation, Settings
plugins/                installation, lifecycle, contribution ownership
features/pages/         page contract and host rendering
features/panels/        target resolution, launcher contract and reusable card/frame
features/relay/         shared channel data, queries, profiles and durable delivery
features/messages/      reusable timeline, message, thread and composer UI
bundled/channels/       Channels navigation, sidebar, page layout and panel placement
bundled/projects/       title-only Projects page scaffold
bundled/agents/         read-only current-Buzz agent library page
features/agents/        shared session-owned local library view
bundled/github/         builtin GitHub panel plugin
bundled/bestie/         builtin companion panel and its snake launcher
```

Channels is the page-authoring example, not a thin registration wrapper over a
host-owned product page. Keep page-specific components, styles, interactions and tests
beside `bundled/channels/index.tsx`. New page plugins should do the same. At the
owner’s request, reusable conversation UI lives in `features/messages`: timeline,
message rows, thread panel, composer, delivery presentation and reading geometry.
Other source plugins can compose those components through ordinary props, with
internal session/destination isolation rather than caller-dependent remount keys.
Import shared capabilities through the existing relay and panel contracts; do not
create a second connection, cache or outbox inside a page. No component registry was
added. Source imports are not yet a versioned external SDK; see
[conversation component ownership](channels.md#reusing-conversation-ui).

## Starting contracts

A plugin exports `inject` and `apply(ctx)`. Pages register with
`ctx.pages.register({ id, title, layout?, companion?, component })`. Panels register with
`ctx.panels.register({ id, title, matches, launcher?, component })`. IDs are local to the
plugin; the registry adds installation identity and revision and removes the
contribution when its Cordis scope ends.

A page calls `panels.resolve(target)` and renders `PanelView` with the resulting
contribution, the target string, and a close callback. The first active matcher
wins; a throwing matcher is skipped. Panels receive `{ target, close }`, without
channel-specific props. A plugin that needs shared data declares `relay` in its
injection list and passes those capabilities to its components using a closure,
just as the bundled Channels page does. No component registry or UI SDK is needed.

Channels owns its selected channel and docked target. The panel view isolates
render failures and remounts on target or revision changes. Unloading a plugin
removes its contributions and closes its panel. Other pages can use these same
contracts with their own layout and local navigation.

The initial distribution contains Channels, Projects, Agents, GitHub and Bestie. Projects
is an enabled-by-default scaffold with only a centered title and no relay dependency.
GitHub recognizes repository,
pull request, issue, and commit URLs and loads public object details on demand.
Unsupported URLs retain ordinary link behavior. Private GitHub connections and
agent operations remain future shared capabilities.

### Top-bar launchers and the companion slot

A panel may supply `launcher: { icon, target }`. The host renders the decorative
image (generic icon on failure) and uses the panel title as the button label.
`target` is an opaque string, including an empty default; it is not an agent URI.
Launcher-only panels use `matches: () => false`. Clicking selects that exact active
contribution, bypassing target matching so another plugin cannot intercept it.

App owns one launched-panel selection, separate from a page’s local target. The
selection starts closed, repeated clicks toggle it closed, and navigation preserves
open intent. Disable/replacement invalidates the installation object; re-enable
stays closed even at the same key/revision. A stale close cannot dismiss a later
opening, including a later opening of the same contribution. Ordinary close returns
focus to the launcher if available.

Pages explicitly opt in with `companion: true` and receive `{ companion?: ReactNode }`,
a ready-to-render card. They must place it in **every** state, including no relay,
loading and empty data. Channels places its local target above this card in one
right column. Non-opted/legacy pages and Home/Settings use the generic host fallback;
there is never a second simultaneous host dock. The fallback frame stays mounted
while opening/closing to preserve page-local state. `PanelCard` and `PanelFrame`
are ordinary shared components, not another registry.

Only open intent crosses pages: the panel component can remount under a new page,
so this mechanism does not promise persistent agent sessions or drafts. Bestie
currently supplies art and truthful not-connected copy, with no send control or
agent API. Both browser and Rust native/CLI catalogs list it as independently
enabled by the normal bundled policy; saved disabled flags still win.

`main.tsx` creates the shared services once; `app/App.tsx` owns startup screens,
navigation, and built-in Settings. `app/services.ts` composes the core services.
Settings and Recovery subscribe directly to plugin management. Page render errors
stay in the page boundary rather than being copied into plugin configuration.

`plugins/manager.ts` is the plugin subsystem's entry point. The app supplies the
Cordis context and bundled manifests/modules. Storage defaults to the platform
adapter, with an optional override for tests. React is provided as `ctx.react`;
external JSX plugins declare `inject = ["react"]` to use the shared instance. The manager
constructs its module loader and execution adapter internally, observes configuration,
and selects the desired plugins (including enabled flags and safe mode).

### Loading from folders and repositories

Desktop Settings → Plugins loads a folder with the native folder picker, or an
HTTPS/SSH Git repository (including GitHub `owner/repository`). An optional branch
or tag is separate from the repository URL; GitHub `tree` URLs are rejected with
guidance rather than ambiguously splitting branch names and subfolders. Discovery
lists built plugin folders by path, name and manifest ID, including nested `dist`
folders. Choose one and explicitly install/update; the same preview can install
another plugin without fetching again. New plugins stay disabled. Updates match
**manifest ID**, even across repositories, and preserve the saved enabled state:
an enabled update may activate immediately except in safe mode. The UI warns before
that action. Installed artifacts do not watch/pull the source; import again to update.

The Rust manager owns acquisition and immutable preview artifacts, with a bounded
single pending preview per native process. Replacing/closing a preview discards it;
leaving Settings ignores and discards a late result, never automatically installing.
Acquisition is separate from the manager's ten-second management-write timeout.
Installation uses the exact captured bytes and retains the existing artifact hash,
profile locking, rollback, recovery and safe-mode behavior. An uncertain write retains
the preview identity for same-artifact retry; it does not refetch or rebuild.

Local discovery skips symlink directories, `node_modules`, `.git` and `target`, and
uses `cap-std` directory-relative reads to confine descendant path resolution. Files
must be regular, non-symlink UTF-8 text; candidate folder names must be UTF-8 and are
not lossily normalized. Discovery never evaluates modules. Git is a required local
tool: a shallow no-checkout clone reads committed blobs, without hooks, filters,
submodules, LFS downloads or project scripts. Only HTTPS/SSH are allowed; inherited
Git config, URL rewrites, credential helpers and interactive prompts are disabled.
SSH uses the existing agent/known hosts, not user SSH config; password entry, HTTPS
private-repo sign-in and custom SSH-config aliases are not supported in this slice.
Repository URLs/refs are passed as arguments, not a shell command. Private/internal
HTTPS hosts are not prohibited; this is not a public-network-only policy.

Git acquisition has a 60-second deadline (including blob discovery), an observed
256 MiB repository limit and bounded command output; transport processes are killed
on failure before temporary cleanup. These are polling limits, not hard OS quotas.
Folder traversal checks a 60-second budget between directory reads (a hung filesystem
syscall is not forcibly cancelled), 32 nesting levels and 20,000 entries. A preview
holds at most 32 plugins / 32 MiB; each artifact retains the 8 MiB limit. No builds
are run: source-only folders explain that the author must supply `manifest.json`
plus the self-contained `plugin.js`. Separate assets/TSX/runtime dependency resolution
remain outside API v1. Browser Settings truthfully directs users to desktop rather
than adding a second external-plugin storage or broadening CSP. Native commands need
a rebuilt/restarted desktop process; frontend HMR alone cannot add them.

`plugins/storage.ts` isolates browser storage and desktop IPC. `plugins/modules.ts`
imports and caches executable revisions. `plugins/runtime.ts` adapts Cordis lifetimes
and owns activation status; contribution services receive a read-only readiness view
of that same status. There is no separately synchronized status store.

The runtime receives only the desired plugins. It retains cancellation and cleanup
barriers around asynchronous imports and replacement; Cordis owns dependency
availability and effect disposal. Stopping plugin management stops polling and its
owned plugin lifetimes. App shutdown starts manager disposal and root-context
disposal together: a hung plugin cannot delay cancellation of shared sessions,
requests or subscriptions. The returned promise rejects after 10 seconds if cleanup
has not finished; it does not claim that arbitrary plugin code has stopped. Plugin
replacement still waits for the predecessor's actual cleanup, even after a timeout.
React owns only subscriptions and presentation state.

Relay consumers use `session.channels` for channel views,
`session.profiles` for shared identities, and `session.read` for
finite filtered event reads. See [relay query ownership](relay-queries.md).

Plugins subscribe to `ctx.relay` connection snapshots and bind work to the current
ready session. `useRelayConnection(relay)` is the React adapter; remount session-owned
views with a key including both scope and generation (for example,
``key={`${connection.scope}:${connection.generation}`}``). Scope distinguishes
retained communities whose generation numbers may match; generation distinguishes
reconnections within one scope. Persist drafts and view intent under scope alone,
not generation. Reactive filtered reads use `session.observe`;
writes use `session.outbox` or the `session.messages` convenience methods. Reads,
live traffic and local events share reconciliation, with no separately injected
write service. Dispose owned views when their plugin or session scope ends.
