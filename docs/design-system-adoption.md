# Shared design system adoption

Buzz keeps Base UI for interaction behavior and uses its own public palette,
Inter and JetBrains Mono. No private fonts, packages, artwork or business examples
are required. The visual direction follows Block UI: clear semantic color roles,
pill actions, consistent fields and shared states.

## From the audit to the app

| Audit area | Shared owner | App adoption |
| --- | --- | --- |
| Colors and type | Semantic surface, text, border and affordance roles | Host aliases forward to shared roles; feature CSS uses role names; inline links have paired text and hover roles. |
| Action sizes and states | Button and IconButton | Retry, refresh, delete, recovery, composer send and picker triggers. Buttons use 32/40/52px minimum sizes and allow labels to wrap. |
| Forms and choices | Field, Input, Textarea, RadioGroup, Checkbox | Profile, community setup, appearance, plugin import and workflow editing. |
| Search | SearchField | Channels, pages, members and GIFs preserve their query, ref and keyboard handlers. |
| Navigation | NavigationItem | Settings, channel rows, shell destinations, Home and community choices. Route destinations remain buttons, not tabs. |
| Tabs | Tabs | Emoji/GIF uses associated panels and Base UI keyboard activation. Workflow mode retains its existing externally owned editor view. |
| Modals | Dialog and AlertDialog | Page search, community chooser/setup and workflow confirmations. Pending work prevents dismissal; focus returns to the opener. |
| Panels and headers | Panel and PanelHeader | Settings, channels and companion cards use shared paint. Grids, scrolling, docks and subscriptions stay with the feature. |
| Hints | Tooltip | Control titles and agent activity use keyboard-accessible, dismissible hints. Accessible names stay on the controls. |
| Sessions and activity | NavigationItem, Button, IconButton, Panel and PanelHeader | Session history, agent choice, child-channel navigation and activity actions retain unread, admission, draft and focus behavior. Base UI owns their menus. |
| Media stages | surface-inverse with text-inverse | Preserve existing stage values and measure their text pairing explicitly; images and video pixels stay renderer-owned. |

## Deliberate local ownership

- The rich message editor keeps its caret, IME, selection and completion logic.
  Completion rows retain `aria-activedescendant` while using shared colors and type.
- GIF and image tiles retain native media-selection buttons and image geometry.
  Search, retry, playback and zoom actions use shared controls. The image zoom
  range retains native range behavior and reads semantic colors; there is no
  separate shared Slider. Media modal focus, drag regions, playback and timecode
  ownership stay with the renderer.
- Emoji Mart keeps its shadow-root adapter and compact search geometry. It reads
  shared semantic colors, type and the host’s keyboard-focus mode. It does not own
  another appearance preference.
- Native disclosures remain for persisted channel groups and diagnostic content.
  They are disclosures, not application menus; their content and state remain local.
- Avatars, previews, links, mentions and thread summaries retain their identity
  and navigation ownership. Composer mentions use inert shared InlineChip rendering;
  editing or deleting the mention removes its notification intent. Host-owned
  recipient avatars beside the mention tool also allow clearing that intent without
  changing authored text. Shared appearance does not move their data.
- Panel marks its surface separately from interactive components. Native product
  and plugin content inside it can still receive host defaults.
- Legacy utility names remain available through the host bridge for existing
  callers and plugins. They are aliases, not another palette. Use the semantic
  names and shared components for new work.

## Checking a migration

Check pointer and keyboard behavior, loading and failures, both color modes,
narrow layouts and enlarged text. A rendered app check matters: a component can
look right in the viewer while its stylesheet is missing from the host.

Browser journeys retain community joining, workflow save/recovery, draft and
sidebar persistence, media insertion and focus checks. Visual assertions should
track the shared treatment. The media journey now checks tab/panel associations,
keyboard activation and search clearing instead of the retired picker-specific
stretch animation. No browser journey is removed by this migration.

Before review/integration, run the contribution workflow’s full batch checks.
Draft PRs and a running preview are not claims of native or full-suite validation.
