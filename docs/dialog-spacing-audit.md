# Dialog spacing audit

Audited on 2026-11-13 against `6896e9ec21814af98dd5109cb9ef064ef92d9296`.
Counts below are production JSX render sites in `src/**/*.tsx`, excluding tests;
conditional states and plugin-provided bodies can produce more runtime screens.
This is a complete source inventory, not a claim that every data-dependent screen
was opened in a native host.

## Origin of the gap

| Date | Commit | Change |
| --- | --- | --- |
| 2026-09-22 | [`f66f89e5b8`](https://github.com/block/buzz-app/commit/f66f89e5b8993ee5833cfa377486a0b0ff9911ff) (#139) | Introduced `.buzz-dialog-content` with vertical padding equal to the outer dialog inset, then 24px. Replaced the outer flex gap with this body padding and grouped title/description. |
| 2026-10-01 | [`c4df139903`](https://github.com/block/buzz-app/commit/c4df1399033786e8f6f6030c10460123a3eaae0e) (#482) | Added the 12px compact header-gap override for channel forms and stepped confirmations. |
| 2026-10-20 | [`7d57af323a`](https://github.com/block/buzz-app/commit/7d57af323ad4b555691ab63d635699ab5de3fe5a) (#1403) | Normalized the outer inset to 32px wide / 16px narrow. The default body-top gap inherited that value. |
| 2026-10-25 | [`6d542ec327`](https://github.com/block/buzz-app/commit/6d542ec3277c2a08a2de3ca6c2daf9a3f5b08716) (#1570) | Added sticky gradient header/footer chrome to ordinary flow dialogs, including another 24px below the header. The body padding remained: total 56px wide / 40px narrow. |
| 2026-11-05 | [`d4e161fd4b`](https://github.com/block/buzz-app/commit/d4e161fd4bca3bd0f4f3de5b41acb425063ac85f) (#2636) | Made sticky headers honor the existing compact override by removing their extra 24px. |

The original source establishes a shared spacing choice as part of dialog polish;
it does not give a separate functional requirement for a large body-top gap.
The later sticky treatment compounded that choice. Workspace/chat settings use
`ChatSettingsDialog`, an ordinary wide flow dialog, so they inherit the full 56px.

## Change and boundaries

Dialog now uses one 12px heading-to-body gap. Existing `headerGap="compact"`
callers retain the same shared recipe; the prop remains compatible. Padded chrome
keeps the gap on the header, outside the body scrollport. Body-bottom padding,
footer gutters, popup insets, sizes, placement, focus, motion, navigation history,
and dismissal have their existing owners.

- AlertDialog shares `.buzz-dialog-content` but has no `data-header-gap` attribute;
  it retains its 32px/16px body inset. Its 43 callers and nine ConfirmAction
  wrappers are inventoried below.
- Header-only dialogs retain the header/action gutter and do not gain an empty body.
  Conditional error/status bodies use the smaller gap only when present.
- Search explicitly owns its 12px field framing. Settings navigation explicitly
  owns a flush body and 32px/16px pane insets; both override the normal body recipe.
- Stable-height, flex, stepped, expanded, and right-side layouts retain their
  sizing and scrolling. Existing compact callers stay compact; default bodies
  gain space for their content rather than changing the outer frame.
- Agent creation's reveal helper measures the actual footer bounds; it does not
  assume a header gap. Member/share list edge bleed depends on horizontal insets,
  which are unchanged. Settings' negative margins belong to the navigated panes.
- MediaAttachment and MediaReviewFrame use renderer-owned modal frames, not this
  spacing class. Toast's dialog role and ChannelPrivacyConfirmation's Base UI
  title do not use the shared spacing class. LaunchSignIn's native HTML dialog
  is a transparent fullscreen top-layer host for its sign-in screen, with its
  own zero-padding class; it is unaffected. Third-party plugin source and
  operating-system dialogs are outside this repository inventory.
- Padded chrome previously had 24px on ordinary sticky headers, 12px on
  non-sticky headers, and 0px when combined with the sticky compact override
  (AgentConfigHistory). These now consistently reserve 12px on the header.

## Per-site source audit

The outcome describes the shared shell. Feature-owned internal field/section
spacing stays with each body. Links refer to the audited file; line numbers are
recorded from the base snapshot above.

| Source | Component | Spacing decision |
| --- | --- | --- |
| [src/app/AgentPluginRequests.tsx:246](../src/app/AgentPluginRequests.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/app/AgentPluginRequests.tsx:272](../src/app/AgentPluginRequests.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/app/App.tsx:781](../src/app/App.tsx) | Dialog | Unchanged flush body and responsive navigation/detail pane insets. |
| [src/app/App.tsx:893](../src/app/App.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/app/CommunityDepartureSettings.tsx:158](../src/app/CommunityDepartureSettings.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/app/DecisionsSettings.tsx:353](../src/app/DecisionsSettings.tsx) | Dialog | Retains existing 12px compact recipe; conditional absent bodies stay absent. |
| [src/app/ExternalIdentityAuthorization.tsx:156](../src/app/ExternalIdentityAuthorization.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/app/IdentitySettings.tsx:1046](../src/app/IdentitySettings.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/app/ManagedPlugins.tsx:506](../src/app/ManagedPlugins.tsx) | Dialog | Header-only; unchanged header/action gutter. |
| [src/app/ManagedPlugins.tsx:541](../src/app/ManagedPlugins.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/app/PluginImport.tsx:1139](../src/app/PluginImport.tsx) | Dialog | Both conditional gap values use 12px; state/step and footer contracts retained. |
| [src/app/PluginMenu.tsx:125](../src/app/PluginMenu.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/app/PluginMenu.tsx:135](../src/app/PluginMenu.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/app/PluginMenu.tsx:195](../src/app/PluginMenu.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/app/SecuritySettings.tsx:148](../src/app/SecuritySettings.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/app/shell/MarkAllReadShortcut.tsx:76](../src/app/shell/MarkAllReadShortcut.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/app/shell/PageSearch.tsx:293](../src/app/shell/PageSearch.tsx) | Dialog | Unchanged 12px search framing. |
| [src/bundled/agents/AgentBrowse.tsx:535](../src/bundled/agents/AgentBrowse.tsx) | Dialog | Retains existing 12px compact recipe; conditional absent bodies stay absent. |
| [src/bundled/agents/AgentCardCreate.tsx:69](../src/bundled/agents/AgentCardCreate.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/bundled/agents/AgentCreateDialog.tsx:298](../src/bundled/agents/AgentCreateDialog.tsx) | Dialog | 12px on fixed header; body remains flush to its scrollport. |
| [src/bundled/agents/AgentIdentityDialog.tsx:61](../src/bundled/agents/AgentIdentityDialog.tsx) | Dialog | 12px on fixed header; body remains flush to its scrollport. |
| [src/bundled/agents/AgentSettingsHost.tsx:319](../src/bundled/agents/AgentSettingsHost.tsx) | Dialog | Retains existing 12px compact recipe; conditional absent bodies stay absent. |
| [src/bundled/agents/AgentShareDialog.tsx:492](../src/bundled/agents/AgentShareDialog.tsx) | Dialog | Retains existing 12px compact recipe; conditional absent bodies stay absent. |
| [src/bundled/agents/AgentsPage.tsx:968](../src/bundled/agents/AgentsPage.tsx) | Dialog | Default body uses 12px; bounded frame and scroll ownership retained. |
| [src/bundled/agents/AgentsPage.tsx:2270](../src/bundled/agents/AgentsPage.tsx) | Dialog | Retains existing 12px compact recipe; conditional absent bodies stay absent. |
| [src/bundled/agents/AgentsPage.tsx:2899](../src/bundled/agents/AgentsPage.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/bundled/agents/BestieChoice.tsx:227](../src/bundled/agents/BestieChoice.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/bundled/agents/BestieChoice.tsx:270](../src/bundled/agents/BestieChoice.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/bundled/agents/BestieChoice.tsx:309](../src/bundled/agents/BestieChoice.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/bundled/agents/ExternalConnectionSettings.tsx:124](../src/bundled/agents/ExternalConnectionSettings.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/bundled/agents/ProviderDialog.tsx:28](../src/bundled/agents/ProviderDialog.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/bundled/agents/ProviderDialog.tsx:75](../src/bundled/agents/ProviderDialog.tsx) | Dialog | Retains existing 12px compact recipe; conditional absent bodies stay absent. |
| [src/bundled/agents/TeamUpdateReview.tsx:48](../src/bundled/agents/TeamUpdateReview.tsx) | Dialog | 12px on fixed header; body remains flush to its scrollport. |
| [src/bundled/bestie/PrivateChannels.tsx:362](../src/bundled/bestie/PrivateChannels.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/bundled/bestie/PrivateChannels.tsx:390](../src/bundled/bestie/PrivateChannels.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/bundled/builderlab/communities/HostedCommunities.tsx:1289](../src/bundled/builderlab/communities/HostedCommunities.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/bundled/builderlab/communities/HostedCommunities.tsx:1375](../src/bundled/builderlab/communities/HostedCommunities.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/bundled/builderlab/communities/HostedCommunities.tsx:1476](../src/bundled/builderlab/communities/HostedCommunities.tsx) | Dialog | Retains existing 12px compact recipe; conditional absent bodies stay absent. |
| [src/bundled/builderlab/communities/HostedCommunities.tsx:1568](../src/bundled/builderlab/communities/HostedCommunities.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/bundled/channels/CanvasEditor.tsx:423](../src/bundled/channels/CanvasEditor.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/bundled/channels/CanvasHistory.tsx:349](../src/bundled/channels/CanvasHistory.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/bundled/channels/ChannelDetailsEditor.tsx:316](../src/bundled/channels/ChannelDetailsEditor.tsx) | Dialog | Retains existing 12px compact recipe; conditional absent bodies stay absent. |
| [src/bundled/channels/ChannelGeneralAccess.tsx:339](../src/bundled/channels/ChannelGeneralAccess.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/bundled/channels/ChannelLifecycleDialog.tsx:220](../src/bundled/channels/ChannelLifecycleDialog.tsx) | Dialog | Header-only; unchanged header/action gutter. |
| [src/bundled/channels/ChannelMembersDialog.tsx:2072](../src/bundled/channels/ChannelMembersDialog.tsx) | Dialog | Both conditional gap values use 12px; state/step and footer contracts retained. |
| [src/bundled/channels/ChannelMembersDialog.tsx:2633](../src/bundled/channels/ChannelMembersDialog.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/bundled/channels/ChannelTemplateSettings.tsx:186](../src/bundled/channels/ChannelTemplateSettings.tsx) | Dialog | Default stepped body uses 12px; crossfade, drafts and absent-body steps retained. |
| [src/bundled/channels/CreateChannelDialog.tsx:292](../src/bundled/channels/CreateChannelDialog.tsx) | Dialog | Retains existing 12px compact recipe; conditional absent bodies stay absent. |
| [src/bundled/channels/CreateSidebarSection.tsx:90](../src/bundled/channels/CreateSidebarSection.tsx) | Dialog | Retains existing 12px compact recipe; conditional absent bodies stay absent. |
| [src/bundled/channels/RenameSidebarSection.tsx:38](../src/bundled/channels/RenameSidebarSection.tsx) | Dialog | Retains existing 12px compact recipe; conditional absent bodies stay absent. |
| [src/bundled/channels/SidebarActiveDialog.tsx:48](../src/bundled/channels/SidebarActiveDialog.tsx) | Dialog | Retains existing 12px compact recipe; conditional absent bodies stay absent. |
| [src/bundled/channels/SidebarSection.tsx:467](../src/bundled/channels/SidebarSection.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/bundled/channels/SoloChatMenu.tsx:204](../src/bundled/channels/SoloChatMenu.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/bundled/charts/ChartExpand.tsx:21](../src/bundled/charts/ChartExpand.tsx) | Dialog | Default body uses 12px; renderer size and scroll ownership retained. |
| [src/bundled/claude-code/ClaudeSettings.tsx:206](../src/bundled/claude-code/ClaudeSettings.tsx) | Dialog | Retains existing 12px compact recipe; conditional absent bodies stay absent. |
| [src/bundled/claude-code/ClaudeSettings.tsx:254](../src/bundled/claude-code/ClaudeSettings.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/bundled/claude-code/tabs.tsx:208](../src/bundled/claude-code/tabs.tsx) | Dialog | Both conditional gap values use 12px; state/step and footer contracts retained. |
| [src/bundled/claude-code/tabs.tsx:619](../src/bundled/claude-code/tabs.tsx) | Dialog | Retains existing 12px compact recipe; conditional absent bodies stay absent. |
| [src/bundled/codex/tabs.tsx:377](../src/bundled/codex/tabs.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/bundled/diffs/DiffMessage.tsx:80](../src/bundled/diffs/DiffMessage.tsx) | Dialog | Default body uses 12px; renderer size and scroll ownership retained. |
| [src/bundled/feedback/FeedbackDialog.tsx:291](../src/bundled/feedback/FeedbackDialog.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/bundled/focus/FocusDialog.tsx:104](../src/bundled/focus/FocusDialog.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/bundled/github/PullChecklist.tsx:466](../src/bundled/github/PullChecklist.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/bundled/goose/tabs.tsx:1081](../src/bundled/goose/tabs.tsx) | Dialog | Default body uses 12px; bounded frame and scroll ownership retained. |
| [src/bundled/huddles/HuddleDiscussionView.tsx:231](../src/bundled/huddles/HuddleDiscussionView.tsx) | Dialog | Default body uses 12px; bounded frame and scroll ownership retained. |
| [src/bundled/huddles/HuddleLauncher.tsx:179](../src/bundled/huddles/HuddleLauncher.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/bundled/mermaid/MermaidExpand.tsx:26](../src/bundled/mermaid/MermaidExpand.tsx) | Dialog | Default body uses 12px; renderer size and scroll ownership retained. |
| [src/bundled/moderation/CommunityAdmin.tsx:414](../src/bundled/moderation/CommunityAdmin.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/bundled/pi/tabs.tsx:511](../src/bundled/pi/tabs.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/bundled/relay-staff/Operators.tsx:195](../src/bundled/relay-staff/Operators.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/bundled/relay-staff/Restrictions.tsx:136](../src/bundled/relay-staff/Restrictions.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/bundled/reminders/RemindDialog.tsx:62](../src/bundled/reminders/RemindDialog.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/bundled/todos/TodosPanel.tsx:933](../src/bundled/todos/TodosPanel.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/bundled/typesafe/TypeSafeSettings.tsx:134](../src/bundled/typesafe/TypeSafeSettings.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/bundled/watching/Tab.tsx:162](../src/bundled/watching/Tab.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/bundled/watching/WatchRow.tsx:438](../src/bundled/watching/WatchRow.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/bundled/workflows/ConfirmAction.tsx:29](../src/bundled/workflows/ConfirmAction.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/bundled/workflows/WorkflowChannel.tsx:538](../src/bundled/workflows/WorkflowChannel.tsx) | ConfirmAction | Unchanged confirmation inset and action gutter. |
| [src/bundled/workflows/WorkflowChannel.tsx:548](../src/bundled/workflows/WorkflowChannel.tsx) | ConfirmAction | Unchanged confirmation inset and action gutter. |
| [src/bundled/workflows/WorkflowConditions.tsx:196](../src/bundled/workflows/WorkflowConditions.tsx) | ConfirmAction | Unchanged confirmation inset and action gutter. |
| [src/bundled/workflows/WorkflowDeletionNotices.tsx:150](../src/bundled/workflows/WorkflowDeletionNotices.tsx) | ConfirmAction | Unchanged confirmation inset and action gutter. |
| [src/bundled/workflows/WorkflowEditor.tsx:212](../src/bundled/workflows/WorkflowEditor.tsx) | Dialog | Default body uses 12px; bounded frame and scroll ownership retained. |
| [src/bundled/workflows/WorkflowEditor.tsx:412](../src/bundled/workflows/WorkflowEditor.tsx) | ConfirmAction | Unchanged confirmation inset and action gutter. |
| [src/bundled/workflows/WorkflowForm.tsx:449](../src/bundled/workflows/WorkflowForm.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/bundled/workflows/WorkflowLanding.tsx:965](../src/bundled/workflows/WorkflowLanding.tsx) | ConfirmAction | Unchanged confirmation inset and action gutter. |
| [src/bundled/workflows/WorkflowLanding.tsx:979](../src/bundled/workflows/WorkflowLanding.tsx) | ConfirmAction | Unchanged confirmation inset and action gutter. |
| [src/bundled/workflows/WorkflowOperations.tsx:151](../src/bundled/workflows/WorkflowOperations.tsx) | ConfirmAction | Unchanged confirmation inset and action gutter. |
| [src/bundled/workflows/WorkflowWebhookSecretDialog.tsx:70](../src/bundled/workflows/WorkflowWebhookSecretDialog.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/bundled/workflows/WorkflowWebhookSecretDialog.tsx:159](../src/bundled/workflows/WorkflowWebhookSecretDialog.tsx) | ConfirmAction | Unchanged confirmation inset and action gutter. |
| [src/features/agents/AgentConfigHistory.tsx:282](../src/features/agents/AgentConfigHistory.tsx) | Dialog | 12px on fixed header; body remains flush to its scrollport. |
| [src/features/agents/AgentManage.tsx:105](../src/features/agents/AgentManage.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/features/agents/AgentManage.tsx:244](../src/features/agents/AgentManage.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/features/agents/AgentSaveButton.tsx:139](../src/features/agents/AgentSaveButton.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/features/agents/ExternalAuthorizationDialog.tsx:100](../src/features/agents/ExternalAuthorizationDialog.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/features/agents/ModelPicker.tsx:98](../src/features/agents/ModelPicker.tsx) | Dialog | Retains existing 12px compact recipe; conditional absent bodies stay absent. |
| [src/features/communities/CommunityDialog.tsx:354](../src/features/communities/CommunityDialog.tsx) | JoinSurface | Modal path uses 12px; onboarding screen bypasses Dialog. |
| [src/features/communities/CommunityDialog.tsx:641](../src/features/communities/CommunityDialog.tsx) | Dialog | Pass-through wrapper; see JoinSurface. No independent spacing override. |
| [src/features/communities/CommunityPicker.tsx:367](../src/features/communities/CommunityPicker.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/features/communities/LegacyCommunityImport.tsx:39](../src/features/communities/LegacyCommunityImport.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/features/conversation/ConversationHost.tsx:163](../src/features/conversation/ConversationHost.tsx) | Dialog | Default body uses 12px; bounded frame and scroll ownership retained. |
| [src/features/credential-pairing/PairingPrompt.tsx:87](../src/features/credential-pairing/PairingPrompt.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/features/identity/BackupConsent.tsx:218](../src/features/identity/BackupConsent.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/features/identity/LegacyIdentityOffer.tsx:37](../src/features/identity/LegacyIdentityOffer.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/features/identity/LinkedKeyCheck.tsx:160](../src/features/identity/LinkedKeyCheck.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/features/identity/LinkedKeyCheck.tsx:178](../src/features/identity/LinkedKeyCheck.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/features/identity/SignOut.tsx:77](../src/features/identity/SignOut.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/features/identity/Welcome.tsx:1034](../src/features/identity/Welcome.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/features/identity/Welcome.tsx:1199](../src/features/identity/Welcome.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/features/messages/ComposerLinkDialog.tsx:48](../src/features/messages/ComposerLinkDialog.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/features/messages/ForwardMessage.tsx:459](../src/features/messages/ForwardMessage.tsx) | Dialog | Retains existing 12px compact recipe; conditional absent bodies stay absent. |
| [src/features/messages/MessageManagement.tsx:787](../src/features/messages/MessageManagement.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/features/messages/ReportMessageDialog.tsx:68](../src/features/messages/ReportMessageDialog.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/features/messages/useBringAgents.tsx:134](../src/features/messages/useBringAgents.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/features/messages/useChatLinkSharing.tsx:175](../src/features/messages/useChatLinkSharing.tsx) | AlertDialog | Unchanged confirmation inset and action gutter. |
| [src/features/messages/useNonmemberMentions.tsx:85](../src/features/messages/useNonmemberMentions.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/features/messages/useOldAgentMentions.tsx:130](../src/features/messages/useOldAgentMentions.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/features/solo/ChatSettingsDialog.tsx:41](../src/features/solo/ChatSettingsDialog.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/features/solo/ConvertToChannel.tsx:285](../src/features/solo/ConvertToChannel.tsx) | Dialog | Retains existing 12px compact recipe; conditional absent bodies stay absent. |
| [src/features/solo/DraftSettings.tsx:101](../src/features/solo/DraftSettings.tsx) | ChatSettingsDialog | Uses ChatSettingsDialog → wide flow Dialog; 56px/40px → 12px. |
| [src/features/solo/NewWorkspace.tsx:126](../src/features/solo/NewWorkspace.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |
| [src/features/solo/WorkspaceSettings.tsx:300](../src/features/solo/WorkspaceSettings.tsx) | ChatSettingsDialog | Uses ChatSettingsDialog → wide flow Dialog; 56px/40px → 12px. |
| [src/features/user-status/StatusEditor.tsx:181](../src/features/user-status/StatusEditor.tsx) | Dialog | Default flow body uses 12px; content/actions and conditional feedback retained. |

## Validation scope

`tests/browser/dialog-footer.spec.mjs` checks browser CSS geometry, sticky chrome,
focus reveal, and footer controls in Chromium and WebKit. Its existing fourteen
layout journeys now also assert the default heading gap or the special composition's
insets at 1280px/light, 800px/dark, and 390px/dark with 200% text. One added case
checks the legacy compact prop across ten layouts at wide/light and narrow/dark
with enlarged text, then checks artwork. jsdom cannot establish these properties.

The padded legacy combination models AgentConfigHistory's former zero gap:
`chromeSpacing="padded"` leaves the body flush, so the header must provide 12px.
The test checks both that total and its header/body ownership. With the original
CSS restored temporarily, the default-flow and padded-compact checks fail in both
engines with 56px and 0px respectively, rather than 12px.

### Test consolidation

The initial patch added eleven cases per engine in `dialog-spacing.spec.mjs` on
top of the footer file's existing 24. The final patch adds one case to the footer
file: 35 → 25 cases per engine across these files, or 70 → 50 across both engines.
Two pre-existing WebKit media-emulation skips remain. No existing footer journey
is removed. The standalone spacing file is replaced by assertions on existing
visits and the focused compatibility/artwork case.

| Removed repetition/assertion | Retained coverage |
| --- | --- |
| Ten default/compact spacing cases, repeating both themes at three sizes | Default gap in each ordinary footer layout's existing three size/theme visits; compact compatibility across every layout at wide/light and narrow/dark/200%. Theme permutations of the same spacing selectors are not repeated. |
| Body begins below the complete header | `headingGap` checks the first body child against the header bounds on every default and compatibility visit. |
| Last field is visible, then Tab reaches Save | The compact compatibility visit retains the original button-footer setup at 390px/200%: Field 16 is fully in the viewport and Tab reaches Save for all ten layouts. Existing mixed-footer journeys retain Save's Tab order and Enter activation; the overflow journey retains direct Field 16 → Save reveal. |
| Separate AlertDialog, header-only, navigation, and search visits | Those existing footer-layout journeys now assert body absence or responsive body/detail insets at all three existing size/theme settings. |
| Separate artwork visit | The compatibility case retains visible artwork and the default 12px gap. |

The standalone suite added 129 fixture navigations per engine. Its replacement
adds 21; the default/special assertions reuse existing visits, removing 108 extra
navigations per engine. These are source-derived navigation counts, not elapsed
CI time claims. App journeys for chat settings, agent creation/error reveal, and
plugin import/review remain separate integration coverage.

The focus check retains its original button-footer precondition. Expanding it to
mixed footer content exposed a separate existing limit: at 390px/200%, the
expanded layout reveals only 70% of the last input in both engines, on upstream
and patched CSS alike. Wide/intermediate diagnostics pass on both versions.
This change does not alter that mixed-footer focus behavior.

### Native capture coverage

Thirty before/after pairs were captured from a running macOS WKWebView at
1280×795 in dark mode. Before used source `6896e9ec21`, including its original
compact callers; after used `6990923b41`. The refreshed PR retains the same shared
spacing selectors; the captures are evidence for that earlier checkpoint rather
than native acceptance of later upstream changes.

| Family | Captured states |
| --- | --- |
| Forms (10) | Workspace settings, Edit chat, New workspace, status, feedback, plugin import, join community, reminder, report message, Add link. |
| Editors/agents (6) | New template, workflow channel chooser, Create agent, avatar editor, import list, multi-community delete-agent confirmation. |
| Channels (7) | Create channel, privacy step, Edit channel, loaded members, archive, delete, Create section. |
| Other controls (7) | Loaded sharing recipients, export-card preview, import confirmation, remove-from-community confirmation, loaded forwarding preview, Settings Appearance, search. |

This is runtime-state coverage, not exhaustive visual acceptance of all 122 source
sites. Pending requests/reviews, provider/auth flows, disabled-plugin renderers,
revision/history bodies, and all their loading/error permutations were not all
opened. Native light/narrow/enlarged-text acceptance and human acceptance remain
separate. No agent/channel/import/destructive confirmation was submitted.

### Refreshed source audit

The JSX inventory was rechecked against upstream `4a87b5cc13`: the same 67 Dialog,
43 AlertDialog, nine ConfirmAction, two ChatSettingsDialog, and one JoinSurface
sites remain. Per-site references above retain their original dated line numbers.
No feature caller retains a header-gap override after the cleanup; only the
shared compatibility API and its fixture exercise it.

## Redundant caller override cleanup

Audited against `050e4bb61f468c97fa4fd031c13e67aaeef52cb5`. All 21 explicit
`headerGap` attributes in 20 production feature files are redundant under the
new shared default and were removed: 18 literal compact values and three pure
conditional expressions choosing compact/default. Plugin import review, channel
member confirmation states, and Claude integration states no longer need to
choose between identical spacing recipes.

No feature caller needs a replacement. Independent `footerGap`, `chromeSpacing`,
height, step, size, focus, pending and dismissal options retain their behavior.
The shared compatibility prop and its browser coverage remain for existing
consumers; new callers should omit it. Line references below identify the
pre-cleanup checkpoint, like the dated inventory above.

| Source | Removed value |
| --- | --- |
| [src/app/DecisionsSettings.tsx:356](../src/app/DecisionsSettings.tsx) | Literal compact |
| [src/app/PluginImport.tsx:1187](../src/app/PluginImport.tsx) | Conditional compact/default |
| [src/bundled/agents/AgentBrowse.tsx:545](../src/bundled/agents/AgentBrowse.tsx) | Literal compact |
| [src/bundled/agents/AgentSettingsHost.tsx:334](../src/bundled/agents/AgentSettingsHost.tsx) | Literal compact |
| [src/bundled/agents/AgentShareDialog.tsx:494](../src/bundled/agents/AgentShareDialog.tsx) | Literal compact |
| [src/bundled/agents/AgentsPage.tsx:2273](../src/bundled/agents/AgentsPage.tsx) | Literal compact |
| [src/bundled/agents/ProviderDialog.tsx:86](../src/bundled/agents/ProviderDialog.tsx) | Literal compact |
| [src/bundled/builderlab/communities/HostedCommunities.tsx:1485](../src/bundled/builderlab/communities/HostedCommunities.tsx) | Literal compact |
| [src/bundled/channels/ChannelDetailsEditor.tsx:318](../src/bundled/channels/ChannelDetailsEditor.tsx) | Literal compact |
| [src/bundled/channels/ChannelMembersDialog.tsx:2100](../src/bundled/channels/ChannelMembersDialog.tsx) | Conditional compact/default |
| [src/bundled/channels/CreateChannelDialog.tsx:305](../src/bundled/channels/CreateChannelDialog.tsx) | Literal compact |
| [src/bundled/channels/CreateSidebarSection.tsx:92](../src/bundled/channels/CreateSidebarSection.tsx) | Literal compact |
| [src/bundled/channels/RenameSidebarSection.tsx:45](../src/bundled/channels/RenameSidebarSection.tsx) | Literal compact |
| [src/bundled/channels/SidebarActiveDialog.tsx:52](../src/bundled/channels/SidebarActiveDialog.tsx) | Literal compact |
| [src/bundled/claude-code/ClaudeSettings.tsx:231](../src/bundled/claude-code/ClaudeSettings.tsx) | Literal compact |
| [src/bundled/claude-code/tabs.tsx:211](../src/bundled/claude-code/tabs.tsx) | Conditional compact/default |
| [src/bundled/claude-code/tabs.tsx:622](../src/bundled/claude-code/tabs.tsx) | Literal compact |
| [src/features/agents/AgentConfigHistory.tsx:303](../src/features/agents/AgentConfigHistory.tsx) | Literal compact |
| [src/features/agents/ModelPicker.tsx:105](../src/features/agents/ModelPicker.tsx) | Literal compact |
| [src/features/messages/ForwardMessage.tsx:463](../src/features/messages/ForwardMessage.tsx) | Literal compact |
| [src/features/solo/ConvertToChannel.tsx:295](../src/features/solo/ConvertToChannel.tsx) | Literal compact |

Verification compares each changed feature file’s parsed code with the checkpoint,
excluding only the audited Dialog attributes. The browser geometry matrix retains
both explicit compact and omitted-prop cases, including padded chrome and stepped
layouts; this cleanup adds no new browser cases.
