# Settings scope and navigation

Buzz distinguishes settings by whether they belong to the community from which
Settings opened or to this Buzz installation.

## Settings navigation

Settings has two groups:

- The selected **community name** comes first. It contains **Profile**, **Personal
  groups**, **Templates & teams**, and future community-scoped personal or
  permission-gated settings.
- **App** contains Appearance, Notifications, Shortcuts, Agents, and Plugins.
  These preferences apply across communities on this device.

Selecting another community in the rail leaves Settings and opens that
community's view. Opening Settings there captures the new community context; the
contents do not change underneath an open form.

The current Profile implementation still edits a device-local seed and does not
publish to the named community. That is a transitional implementation, not the
final product contract. The community-settings batch must make Profile edit the
captured community profile, update the local seed only after an accepted publish,
and leave other existing community profiles unchanged.

## Appearance roadmap

Conversation density, link-preview style, and thread layout are approved as
personal device preferences across communities. They belong under **Appearance**,
not inside an individual community.

Do not add their controls before Buzz 1.0 owns the corresponding modes end to end:

- **Conversation density** needs Compact, Comfy, and Spacious treatments across
  channel and thread messages, grouped activity, attachments, narrow layouts,
  enlarged text, virtualized measurement, and scroll anchoring.
- **Link previews** needs a defined Compact and Rich contract for ordinary links,
  internal Buzz links, plugin renderers, loading, and unavailable metadata.
- **Thread layout** needs both Focus and Split workspaces with responsive layout,
  panel competition, navigation history, draft and scroll retention, focus return,
  and accessible keyboard behavior.

The preference owner must persist these choices on this device and apply them to
all communities. A community switch must not replace them.

## Shortcut coverage

Shortcuts lists the live host and plugin registry, not a copied reference table.
Every listed action must work in the current build and support safe rebinding.
Focused interaction semantics such as editor Enter, dialog Escape, list arrows,
and Tab remain with their owning component and are not global preferences.

Implemented host actions include Home, navigation history, search, Settings, and
text sizing. Enabled plugins may contribute their own actions. Two current global
candidates remain with their feature owners:

- Channels may register **Create channel** when it can open the actual dialog and
  report its current availability.
- Conversation views may register **Mark as read** only after defining the exact
  channel/thread target and preserving Escape's local close behavior.

Do not add reference-only or unavailable shortcuts to fill out the current Buzz
list. Add a shortcut when its real action has one lifecycle and execution owner.

## Agent preferences roadmap

**Keep awake while agents are active** is approved as a future device-wide Agents
preference. It applies to app-owned local agents across communities; per-agent and
community-specific controls do not belong in this setting.

Do not expose the control until the native host owns the complete lifecycle:

- acquire idle-sleep prevention only when the preference is on and at least one
  app-owned local agent is running;
- release it when agents stop, the preference is turned off, ownership changes,
  or Buzz quits;
- use recent agent activity to refresh a bounded assertion, with a one-hour
  inactivity cap so an idle or stuck process cannot keep the device awake forever;
- keep the activity signal independent of the optional Agent Activity plugin;
- report acquisition failure and unsupported platforms honestly rather than
  showing an active setting that has no effect.

The first implementation may be macOS-only if other platforms show an explicit
unsupported state. Linux and Windows need their own inhibitor decisions and native
acceptance. Agent runtime catalogs and inherited global defaults remain separate
product slices; individual-agent configuration stays on the Agents page.

## Settings coverage ledger

The [current Buzz inventory](current-buzz-settings-inventory.md) is a coverage
checklist, not automatic permission to reproduce every control. Update this table
when a product decision or complete Buzz 1.0 owner exists.

| Area | Current Buzz 1.0 decision |
| --- | --- |
| Profile details and public identity | Implemented as a device-local default; existing community profiles remain independent. |
| Identity backup, sign out, and delete data | Pending a security-reviewed identity and destructive-data lifecycle. |
| Color mode and text size | Implemented as personal device preferences across communities. |
| Conversation density, link previews, and thread layout | Approved as future personal device preferences; modes not yet implemented. |
| Theme style, accent color, and native glass | Undecided; do not imply a user-selectable theme system from design tokens alone. |
| Desktop alerts, categories, master sound, and Dock badge | Implemented; operating-system permission remains separate. |
| Per-category sounds and sound preview | Pending a sound catalog, assets, preview, persistence, and delivery contract. |
| Agent conversation behavior | Implemented under **Agents**. |
| Keep awake while agents are active | Approved as a future device-wide preference; requires the bounded native lifecycle above. |
| Agent runtimes and inherited defaults | Separate future native-agent product decisions; individual configuration remains on the Agents page. |
| Voice, custom emoji, local archive, and channel templates | Pending dedicated product and implementation slices. |
| Compute, experiments, mobile pairing, and updates | Pending dedicated native/app capability owners. |
| Community profiles and administration | Planned for the Communities list-detail architecture below. |

Do not add empty destinations or functional-looking placeholders for pending rows.

## Community settings

Community-specific personal settings and administration share the named community
group. **Profile**, **Personal groups**, and **Templates & teams** are available
to ordinary members. Permission-gated entries such as members, invites,
moderation, or hosting appear only when verified evidence for that exact
community authorizes them.

Settings must retain the captured community scope in navigation and asynchronous
work. A saved membership, display name, local profile, selected rail item, or
hosting relationship does not establish administration permission. Contextual
**Community settings** actions may deep-link to the same captured surface; they
must not create a second implementation.

## Hosting boundary

Builderlab hosting account controls and community administration have different
authorization owners:

- service-level sign-in, quota, identity binding, and community creation belong
  at the Communities hub;
- actions concerning one hosted community belong in that community's detail;
- hosting ownership must not be presented as relay membership or community role
  unless verified evidence establishes both.

## Current implementation boundary

This change establishes the selected community and **App** groups, places the
existing Profile and contributed community cards under the community name, and
places agent conversation behavior under **Agents**. It does not yet change the
local-only Profile persistence contract or add permission-gated community
administration.

Add new community entries only with real behavior and honest unavailable,
permission, loading, and recovery states.

## Development logging

Local Vite development builds expose **Developer → Runtime settings → Log level**.
The choice applies immediately to broker terminal logs and browser relay
diagnostics, and is saved in the worktree's ignored `.buzz/developer-settings.json`.
It survives app/dev-server restarts and is shared by tabs using that server, not
by other worktrees or communities on other installations. It works even without a
configured relay broker. Production builds do not serve the settings endpoint.

- **Info** (default): connection lifecycle, warnings and errors.
- **Debug**: every completed broker HTTP request and each relay application
  WebSocket frame in both directions, including identical repeats; no sampling or
  duplicate suppression.
- **Trace**: Debug plus bounded query/filter metadata.
- **Warn**, **Error**, and **Silent** progressively reduce output.

Traffic summaries include method/action, status and duration for HTTP, and
relay host, direction, frame type, short event/subscription IDs, kind and size for
WebSockets. They omit message bodies, signatures, auth challenges, URL credentials
and query strings. Trace shows filter kinds, limits, time bounds and ID counts,
not searches or full authors/tags. This is diagnostic output, not a retained audit
log or an OS/network packet capture: native Rust transport and WebSocket control
frames are outside this TypeScript logger.

The implementation uses [Consola](https://github.com/unjs/consola) through
`src/features/developer/logging.ts`; new owned TypeScript diagnostics can reuse
`getLogger("component")`. Do not wrap the global console or dump raw payloads.
The shared TypeScript logger is also bundled with production clients at Info;
only its Vite settings endpoint/control and live level synchronization are dev-only.
The former `buzz.debug.relay` localStorage switch is replaced by this control.
Failure logs use static WebSocket reasons and allowlisted broker exception categories
and network codes, not arbitrary error messages/stacks that may embed private data.
