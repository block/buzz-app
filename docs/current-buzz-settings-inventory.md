# Current Buzz settings inventory

This is a source-of-truth inventory of user-facing settings in the released/current Buzz clients. It is a coverage checklist for Buzz 1.0, not a requirement to reproduce current Buzz's information architecture, implementation, defaults, or every advanced control.

## Scope and source snapshot

- **Current Buzz source:** `block/buzz` at `eac8b71e1a5c5604a4fbcd8f1b9491bb480b1068` (local checkout, 2026-09-22).
- **Clients covered:** current Buzz Desktop and Mobile.
- **Included:** dedicated Settings surfaces plus channel/community controls that behave like settings but live in contextual management surfaces.
- **Excluded:** ordinary one-shot actions such as composing, reacting, and creating a channel unless they configure durable behavior; relay operator/admin-web configuration; unreleased code not exposed by the clients.
- **Interpretation:** a row marked **conditional** is hidden, disabled, or only meaningful for a platform, feature flag, role, connection state, or selected theme.

Current Buzz Desktop declares 16 Settings destinations. The sidebar groups them under Personal, Communities, and App, although `Moderation` is declared and renderable but is not currently listed in those sidebar groups. Sources: `desktop/src/features/settings/ui/SettingsPanels.tsx:84-237`, `desktop/src/features/settings/ui/SettingsView.tsx:51-76`, `desktop/src/features/settings/ui/SettingsView.tsx:130-153`.

## Desktop Settings

### Profile

| Setting or action | Current behavior / choices | Availability |
|---|---|---|
| Avatar | View and edit the profile avatar, including the image/emoji/animated avatar editor. | Always; camera/upload capabilities can vary by runtime. |
| Display name | Edit the public display name. | Always. |
| Profile description | Edit the public profile bio/about text. | Always. |
| Identity | View and copy the account public key / identity identifiers. | Always; values depend on loaded profile and identity. |
| Private-key backup | Create a password-protected identity backup and test an existing backup. | When a local identity is available. |
| Sign out | Deletes the local identity key, agent settings, and cached local data after confirmation. | Always; destructive. |

Sources: `desktop/src/features/settings/ui/ProfileSettingsCard.tsx:134-318`, `desktop/src/features/settings/ui/ProfileSettingsCard.tsx:487-806`, `desktop/src/features/settings/ui/PrivateKeyBackupRow.tsx`, `desktop/src/features/settings/ui/SignOutSection.tsx:35-164`.

### Appearance

Appearance is scoped per community when more than one community is connected.

| Setting | Choices / behavior | Availability |
|---|---|---|
| Color mode | System, Light, Dark. | Always. |
| Theme style | Select from paired system-aware themes or individual light/dark syntax themes. | Always. |
| Accent color | Select an accent color. | Hidden for Buzz themes, which use a fixed neutral accent. |
| Glass background | Blur the desktop behind navigation while keeping content solid. | Hidden on Linux; disabled when the native runtime does not support it. |
| Glass opacity | Adjust and reset desktop-blur opacity. | Only when Glass background is supported and enabled. |
| Prominent active tab | Use a higher-contrast background for the selected navigation item. | Buzz themes only. |
| Font size | Smaller, Default, Larger. | Always. |
| Conversation density | Compact, Comfy, Spacious. | Always. |
| Link previews | Compact or Rich. | Always. |
| Thread layout | Focus (thread overlays channel) or Split (side panel). | Always. |

Sources: `desktop/src/features/settings/ui/SettingsPanels.tsx:401-560`, `desktop/src/features/settings/ui/SettingsPanels.tsx:634-797`, `desktop/src/features/settings/ui/AppearanceSettingsControls.tsx:47-128`, `desktop/src/features/settings/ui/AppearanceSettingsControls.tsx:202-254`, `desktop/src/features/settings/ui/AppearanceSettingsControls.tsx:340-493`, `desktop/src/features/settings/ui/AppearanceSettingsControls.tsx:378-393`, `desktop/src/features/settings/ui/AppearanceSettingsControls.tsx:619-715`.

### Notifications

| Setting | Choices / behavior | Availability |
|---|---|---|
| Desktop alerts | Requests OS permission and enables/disables native desktop alerts. | Can be blocked or unsupported by the OS/runtime. |
| Notify while viewing | Also alert for direct messages in the currently open conversation. | Only when Desktop alerts is enabled. |
| Sound | Master switch derived from the enabled live alert categories. | Only when Desktop alerts is enabled. |
| Alert categories and sounds | Enable each category and select its sound: Direct messages, @Mentions, Thread replies, and Needs action. Agent job accepted/progress/result/error categories are wired but currently shown disabled as **Coming soon** under **View all**. | Only when Desktop alerts and Sound are enabled; “coming soon” categories are read-only. |
| Home badge | Show a Home sidebar badge for mentions and needs-action items. | Always; independent of OS alert permission. |

Sources: `desktop/src/features/settings/ui/NotificationSettingsCard.tsx:28-65`, `desktop/src/features/settings/ui/NotificationSettingsCard.tsx:66-288`, `desktop/src/features/notifications/lib/sound.ts`.

### Voice

| Setting or action | Choices / behavior | Availability |
|---|---|---|
| Agent text to speech | Read new agent messages aloud in arrival order during an active huddle. | Desktop native runtime. |
| Pocket TTS voice | Select a local voice. | Enabled when agent text to speech is on. |
| Preview voice | Play a sample of the selected voice. | A voice must be available. |
| Add voice | Import a voice file that remains on the device. | Agent text to speech enabled. |
| Delete imported voice | Remove an imported voice and its local audio file; falls back to Mary when needed. | Imported voices only. |

Source: `desktop/src/features/settings/ui/VoiceSettingsCard.tsx:38-185`, `desktop/src/features/settings/ui/VoiceSettingsCard.tsx:187-379`.

### Agents

| Group | Setting or action | Current behavior |
|---|---|---|
| Conversations | Automatically mention agents | After an agent is mentioned once, keep it addressed in subsequent conversation drafts. |
| Preferences | Keep awake while agents are active | Prevent sleep while local agents run; releases when they stop or after one hour without agent activity. |
| Agent runtimes | Installed runtime enablement and health | Review detected runtimes, enable/disable supported runtimes, install/update where supported, open setup/download guidance, and refresh detection. Windows also reports Git Bash prerequisites. |
| Agent runtimes | Add runtimes | Browse supported runtimes or define a custom runtime. |
| Agent defaults | Provider, model, effort, environment | Configure defaults inherited by local agents; per-agent values override them. |

The Agents destination is feature-gated by `managed-agents`. Sources: `desktop/src/features/settings/ui/AgentsSettingsPanel.tsx`, `desktop/src/features/settings/ui/PreventSleepSettingsCard.tsx`, `desktop/src/features/settings/ui/HarnessesSettingsPanel.tsx:101-220`, `desktop/src/features/settings/ui/HarnessCatalogDialog.tsx`, `desktop/src/features/settings/ui/AgentDefaultsSettingsCard.tsx`, `desktop/src/features/agents/ui/AgentConfigFields.tsx`.

### Channel templates

| Setting or action | Current behavior |
|---|---|
| Create template | Save a reusable template with name, description, canvas content, selected agent personas/teams, and runtime assignments. |
| Edit template | Change a saved template. |
| Duplicate template | Copy an existing template. |
| Delete template | Delete a non-built-in template after confirmation; built-ins cannot be deleted. |

The destination is feature-gated by `channel-templates`. Source: `desktop/src/features/settings/ui/ChannelTemplatesSettingsCard.tsx:62-194`, `desktop/src/features/settings/ui/ChannelTemplatesSettingsCard.tsx:198-287`, `desktop/src/features/settings/ui/ChannelTemplatesSettingsCard.tsx:291-540`.

### Compute

| Setting | Choices / behavior | Availability |
|---|---|---|
| Share this machine | Allow members of the current relay/community to run agents on this machine. | Requires a valid selected local model and an available compute slot. |
| Model | Pick a hardware-aware catalog model, an installed model, or enter a custom model reference. | Disabled while sharing state is changing. |
| Max VRAM | Optional GB limit; blank means no limit. | Under Advanced. |
| Status / debug console | Shows lifecycle, health, consumers, downloads, and a debug-console link when supplied. | Informational while compute is active or changing. |

Source: `desktop/src/features/mesh-compute/ui/MeshComputeSettingsCard.tsx:227-403`, `desktop/src/features/mesh-compute/ui/MeshComputeSettingsCard.tsx:456-580`.

### Experiments

Current preview switches are generated from `preview-features.json` rather than hard-coded into the panel:

- Workflows
- Projects
- Pulse
- Forum Channels
- Agent-managed profiles
- Bestie (only in builds carrying the required `bestie` build flag)

Sources: `preview-features.json`, `desktop/src/features/settings/ui/ExperimentalFeaturesCard.tsx`.

### Keyboard shortcuts

This is a read-only reference, not a preference editor. Current groups are:

- **Navigation:** Quick search, Browse channels, New direct message, New channel, Settings, Go back, Go forward, Find in channel, Home, Toggle sidebar, Mark as read, Mark all as read.
- **Zoom:** Zoom in, Zoom out, Reset zoom.
- **Messages:** Send message, New line, Always address agent, Publish note, Close dialog, Start or leave huddle, Push to talk.
- **Formatting:** Bold, Italic, Strikethrough, Inline code, Insert link.

Platform-appropriate key labels are shown. Sources: `desktop/src/features/settings/ui/KeyboardShortcutsCard.tsx`, `desktop/src/shared/lib/keyboard-shortcuts.ts:24-248`.

### Custom emoji

| Setting or action | Current behavior | Availability |
|---|---|---|
| Add emoji | Upload an image and assign/normalize its shortcode. | `custom-emoji` feature enabled. |
| My emoji | View and remove emoji owned by the current identity. | Owners can remove their own entries. |
| Community emoji | View emoji added by other members. | Read-only; only each entry's owner can remove it. |

Source: `desktop/src/features/custom-emoji/ui/CustomEmojiSettingsCard.tsx:128-337`.

### Local archive

| Setting or action | Current behavior |
|---|---|
| Archive my agents' observer frames | Persist ephemeral observer frames addressed to the user's public key. |
| Archive my agents' turn metrics | Persist agent turn metrics as plaintext in the local archive. |
| Channel subscriptions | Review and remove channel archive subscriptions. |
| Add channel subscription | Select a joined channel and event kinds to retain. Kind groups cover messages/posts, reactions/edits/deletions, huddle events, and system messages. Advanced input accepts custom Nostr kind numbers. |

Data is stored in a local SQLite database in the Buzz nest and events are re-verified at archive time. Sources: `desktop/src/features/local-archive/ui/LocalArchiveSettingsCard.tsx:65-154`, `desktop/src/features/local-archive/ui/LocalArchiveSettingsCard.tsx:156-240`, `desktop/src/features/local-archive/ui/LocalArchiveSettingsCard.tsx:519-639`, `desktop/src/features/local-archive/ui/localArchiveKinds.ts:13-83`.

### Mobile pairing

Desktop can create and manage a time-limited QR pairing session used to connect Buzz Mobile and transfer the current identity. The surface supports generating/retrying/cancelling a code and reflects waiting, approval, completion, expiry, and failure states. Availability depends on a usable identity and relay/community connection.

Source: `desktop/src/features/settings/ui/MobilePairingCard.tsx:395-558`.

### Software updates

Displays update status and supports checking again, opening a release URL where automatic updates are unavailable, and installing/relaunching when an update has downloaded. The exact controls vary by status and package format; Linux may direct non-AppImage users to switch builds for automatic updates.

Source: `desktop/src/features/settings/UpdateChecker.tsx:13-170`.

## Desktop community administration

### Hosted communities

This page manages **Block-provided relay hosting**, not the settings of every connected community. It uses a separate Builderlab sign-in limited to this page.

| Setting or action | Current behavior |
|---|---|
| Builderlab account | Sign in/out in the browser. |
| Buzz identity binding | Connect the device identity, switch a mismatched binding to this device, or unpair it. Private keys remain local. |
| Hosted community list | Refresh, connect to a community, and set the active hosted community's icon. |
| Community lifecycle | Archive or unarchive a hosted community. Archiving stops connections and reserves the address; it does not delete the community or free quota. |
| Transfer ownership | Transfer a hosted community to a recipient npub. |
| Create hosted community | Choose an available `*.builderlab.xyz` address and create/connect it, subject to account quota. |

Source: `desktop/src/features/settings/ui/HostedCommunitiesSettingsCard.tsx:417-696`, `desktop/src/features/settings/ui/HostedCommunitiesSettingsCard.tsx:700-870`.

### Invites and members

The destination appears only after verified current-relay membership says the user is an **owner or admin**. Open relays without a membership snapshot do not expose it.

| Setting or action | Permission |
|---|---|
| Invite to community | Owner or admin; invite capabilities in the dialog vary by owner status. |
| Search member roster | Owner or admin. Searches display name, NIP-05, npub/hex key, and role. |
| Make admin / make member | Role-dependent; owner-only boundaries are enforced by the member-action predicates. |
| Remove from community | Role-dependent; cannot be inferred from profile identity or display name. |

Sources: `desktop/src/features/settings/ui/SettingsView.tsx:130-153`, `desktop/src/features/community-members/ui/CommunityMembersSettingsCard.tsx:121-245`, `desktop/src/features/community-members/ui/CommunityMembersSettingsCard.tsx:247-385`, `desktop/src/features/community-members/ui/CommunityInviteDialog.tsx`.

### Moderation

Moderators can review reported content and apply these resolution actions:

- Delete content
- Kick author
- Ban author
- Time out author
- Escalate to platform safety
- Dismiss with no violation

`Moderation` is declared as a Settings destination, but the current sidebar group list does not include it; Buzz 1.0 should not assume that omission is intentional product scope. Sources: `desktop/src/features/settings/ui/ModerationQueueCard.tsx:145-176`, `desktop/src/features/settings/ui/ModerationQueueCard.tsx:573-575`, `desktop/src/features/settings/ui/SettingsPanels.tsx:211-215`, `desktop/src/features/settings/ui/SettingsView.tsx:51-76`.

## Contextual channel settings on Desktop

These are not in the global Settings sidebar, but they are durable channel settings and administration controls that Buzz 1.0 must account for.

| Setting or action | Current behavior / choices | Permission / condition |
|---|---|---|
| Name | Edit channel name. | Channel owner/admin; non-DM. |
| Description | Edit channel description. | Channel owner/admin; non-DM. |
| Channel type | Standard, temporary, or project where allowed. | Channel owner/admin; project type only for a project home. |
| Expires after | 30 minutes, 1/6/12 hours, 1/3/7/14/30 days, while preserving nonstandard current values. | Temporary channels only. |
| Visibility | Public or Private. | Channel owner/admin; non-DM. |
| Members | View the roster and open member management. | Viewing depends on channel access; changes depend on role. |
| Canvas | View/edit shared channel canvas. | Editing uses channel narrative permissions and archive state. |
| Workflows | View/create/open channel workflows. | Workflows experiment enabled; mutation permissions apply. |
| Join / Leave | Add or remove the channel from the user's membership/sidebar. | Open unjoined channels / eligible joined non-DM channels. |
| Archive / Unarchive | Change channel lifecycle without deleting it. | Channel owner/admin; non-DM. |
| Delete channel | Permanently delete after confirmation. | Owner-level delete gate; non-DM. |

Sources: `desktop/src/features/channels/ui/ChannelManagementSheet.tsx:137-161`, `desktop/src/features/channels/ui/ChannelManagementSheet.tsx:481-580`, `desktop/src/features/channels/ui/ChannelManagementSheet.tsx:721-994`, `desktop/src/features/channels/ui/ChannelTypeSettings.tsx`, `desktop/src/features/channels/ui/ChannelPermissionsSettings.tsx`.

Current Buzz also stores per-user contextual channel preferences outside the management sheet: star/unstar, mute/unmute, sidebar section placement/removal, mark read/unread behavior, and thread display mode (the latter is also exposed globally under Appearance). These are user preferences, not channel-authority settings.

## Mobile Settings

Mobile has a smaller account/community Settings page rather than mirroring Desktop's complete settings hierarchy.

### Profile

- Edit display name.
- Edit profile description.
- Edit profile photo.

Source: `mobile/lib/features/settings/settings_page.dart:75-141`.

### Community

- **Invite to community** appears only for a current community owner/admin. Permission errors keep the row discoverable rather than silently treating the user as unauthorized.

Source: `mobile/lib/features/settings/settings_page/community_section.dart`.

### Style · This community

| Setting | Choices / behavior |
|---|---|
| Appearance | System, Light, Dark. |
| Theme | Select a theme compatible with the selected appearance mode. |
| Accent color | Select an accent; hidden for Buzz themes. |

These choices are scoped to the current community. Sources: `mobile/lib/features/settings/settings_page/appearance_section.dart`, `mobile/lib/features/settings/theme_picker_page.dart`, `mobile/lib/features/settings/accent_picker_page.dart`.

### Connection

| Setting or action | Current behavior |
|---|---|
| Identity (pubkey) | View/copy the public key derived from the local identity. |
| Send identity to desktop | Authorize identity export, scan a recovery code from Desktop, and complete pairing after the app resumes. |
| Remove community | Disconnect the current community and return to pairing; reconnecting requires a new pairing code. |

Source: `mobile/lib/features/settings/settings_page/connection_section.dart`.

### Contextual mobile channel controls

Mobile exposes durable channel/user preferences in its channel action and management sheets:

- Star / unstar channel.
- Mute / unmute channel.
- Move to a sidebar section or remove from a section.
- Manage channel metadata and membership when authorized.
- Leave channel.
- Archive channel.
- Delete channel when the owner-level delete gate is satisfied.
- Channel member administration supports adding members and changing roles through signed channel-management events.

Sources: `mobile/lib/features/channels/channel_actions_sheet.dart:82-120`, `mobile/lib/features/channels/channel_actions_sheet.dart:140-219`, `mobile/lib/features/channels/channel_actions_sheet.dart:270-332`, `mobile/lib/features/channels/channel_actions_sheet.dart:358-376`, `mobile/lib/features/channels/channel_actions_sheet.dart:574`, `mobile/lib/features/channels/channel_management_actions.dart`.

## Buzz 1.0 accounting checklist

Use these statuses when mapping the inventory into Buzz 1.0:

- **Carry forward:** required in Buzz 1.0 with equivalent user outcome.
- **Redesign:** required outcome, intentionally different interaction or information architecture.
- **Compatibility boundary:** remains owned by current Buzz/native runtime for now; Buzz 1.0 may expose read-only status or a handoff.
- **Defer:** intentionally outside the current Buzz 1.0 milestone.
- **Retire:** intentionally not carried forward, with migration/recovery implications addressed.

Before implementation, decide each category below rather than assuming parity:

- [ ] Profile and identity recovery
- [ ] Appearance and readability
- [ ] Notifications, sounds, and badges
- [ ] Voice and local voice assets
- [ ] Agent conversation behavior, runtimes, defaults, and sleep prevention
- [ ] Channel templates
- [ ] Shared compute
- [ ] Experiments
- [ ] Keyboard shortcut reference
- [ ] Custom emoji
- [ ] Local archive
- [ ] Mobile pairing
- [ ] App updates
- [ ] Hosted-community account and lifecycle management
- [ ] Community invites, roster, roles, and removal
- [ ] Moderation
- [ ] Channel metadata, visibility, lifecycle, membership, canvas, and workflows
- [ ] Per-user channel preferences (star, mute, section placement, read state)
- [ ] Mobile-only recovery/removal flows
