# Settings scope and navigation

Buzz distinguishes settings by who owns their state. Navigation follows that
ownership instead of the currently selected community.

## Global settings

The global Settings page contains preferences that apply across communities in
this Buzz installation. Switching communities does not replace their values.

- **Personal** contains identity-scoped defaults and account preferences saved on
  this device. **Profile** supplies the shell identity and pre-fills a community
  profile when that community has no existing profile. It does not republish
  profiles that already exist in communities.
- **Personal** also contains appearance, notifications, and shortcuts that follow
  this person across communities on the device.
- **App** contains installation-level capabilities such as agents and plugins.

A setting can still be partitioned by identity or depend on an operating-system
permission. Those details must be explained where they affect behavior, but they
do not make the setting community-scoped.

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

Community-specific personal settings and administration do not belong among the
global destinations. The planned **Communities** destination is a list-detail
surface:

1. List communities associated with this identity and installation.
2. Open one community to manage its scoped sections.
3. Show personal sections such as **Your profile** separately from permission-
   gated administration such as members, invites, moderation, or hosting.

Do not add every community to the primary Settings navigation. The list must
remain usable with many communities, long names, changing roles, narrow windows,
and enlarged text. Contextual **Community settings** actions may deep-link to the
same community detail; they must not create a second implementation.

Joined, administered, and hosted are attributes, not exclusive navigation
buckets. Authorization comes from verified community evidence for the exact
community. A selected community, saved membership, display name, local profile,
or hosting relationship does not establish administration permission.

## Hosting boundary

Builderlab hosting account controls and community administration have different
authorization owners:

- service-level sign-in, quota, identity binding, and community creation belong
  at the Communities hub;
- actions concerning one hosted community belong in that community's detail;
- hosting ownership must not be presented as relay membership or community role
  unless verified evidence establishes both.

## Current implementation boundary

This change establishes the global **Personal** and **App** groups, explains
Profile's default behavior without renaming the current Buzz destination, and
places agent conversation behavior under the existing **Agents** destination.
The temporary **Channels** destination retains main's implemented Personal groups
and Templates & teams cards without misclassifying them as agent preferences. The
future Communities work should move those community-scoped cards into the owning
community detail, then remove this temporary destination.

This change does not add a placeholder Communities control. Add that destination
only with a real community list/detail path and honest unavailable, permission,
loading, and recovery states.
