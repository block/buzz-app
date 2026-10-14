# Shared conversation composition

Proposed direction, October 13, 2026. This document describes the remaining structural repair requested for Inbox and Channels. It does not describe implemented parity.

## Outcome

Inbox and Channels should receive messaging features from the same feature-owned composition. A page should not have to remember to add another editing provider, profile callback, or composer dependency when a shared messaging feature changes.

The first interaction repair is [PR 977](https://github.com/block/buzz-app/pull/977). It fixes person mentions and missing profile/panel/media dispatch, but Channels still creates its interaction handlers separately and the pages still assemble readers and composers independently. The whole outcome remains unfinished. [PR 815](https://github.com/block/buzz-app/pull/815) has merged its recovery wrapper; preserve that implementation and its tests.

## Existing owners to retain

`MessageRow` and `MessageMarkdown` own message presentation and reference resolution. `ThreadPanel` owns exact-thread loading, reveal, reply branches, and its reply composer. `ChannelTimeline` owns the canonical channel window, scrolling, and reading evidence. `MessageComposer` owns drafts, recipients, attachments, and publication. `MessageManagement` owns channel-scoped editing/deletion recovery and the channel visit. None of these needs a replacement implementation.

Today, `ChannelsPage`, `ConversationTab`, `InboxDetail`, `ChannelPreview`, and `DraftsView` choose and connect those owners separately. That assembly is the boundary to extract.

## Proposed boundary

Use one feature-owned conversation composition with two explicit lifetimes:

- A channel scope owns `MessageManagement`, recovery status, the complete interaction environment, and overlay dispatch. Its identity follows the relay session and channel. Switching threads within that channel must not discard recovery or create another channel visit.
- A reader owns the selected channel timeline or exact thread and the matching composer. It consumes the channel scope directly. Its identity and navigation intent follow the selected target, preserving the current retained-thread/editor rules.

The two lifetimes are parts of one composition, rather than independent page-owned providers. Callers select a channel or thread target. The composition chooses the existing reader, connects the composer, derives session-recipient context from channel metadata, and supplies the same feature dependencies to both. Callers cannot replace the reader with arbitrary JSX that omits those dependencies.

Extract the working Channels assembly first. Move its channel-body logic into the conversation feature rather than import a bundled Channels page from Inbox. Adopt that owner in the primary Channels pane and secondary conversation tabs before switching Inbox, saved drafts, and embedded threads. Remove the old page-owned reader/composer assembly after adoption.

## Preserved page policy

Pages continue to own navigation placement, admission, and presentation. Channels keeps dock/tab layout and its routed session/conversation behavior. Inbox keeps selected-item admission, reconnect withholding, list/detail focus restoration, exact-target reveal, and forced-unread intent. Saved drafts keep draft retirement and verified-root gating.

Read/visit policy must be explicit and distinct from visibility. Merged Inbox currently supplies `MessageManagement active={false}` to preserve forced-unread intent while its admitted reader still earns the existing reading evidence. A hidden retained reader must dismiss portals and earn no reading dwell. Do not use one boolean to collapse these different policies.

Panel placement is a presentation adapter: Channels uses its existing dock, while Inbox and embedded threads may use the shared Dialog/PanelView fallback. The shared composition owns routing, availability, and contribution lifetime; the adapter determines where an accepted panel appears. Media review and profile actions receive the originating channel/thread context in either placement.

Navigation attempts, admission, publication, and relay authority stay with their existing services. This extraction does not change protocol semantics, signing, draft storage, read-state definitions, or the plugin contribution API. The FOUNDATION contribution contract and panel service do not need editing.

## Preparation and implementation checkpoints

1. Reconcile PR 977 with merged PR 815, preserving the recovery wrapper and its `active={false}` policy. Run the existing Inbox editing and mention journeys together.
2. Extract the Channels channel-scope and reader composition with no behavior change. Adopt it in Channels and its conversation tabs, using their existing navigation and dock adapters.
3. Switch Inbox, channel previews, saved drafts, and embedded threads to that composition. Delete duplicated reader/composer assembly and feature callback forwarding from the page modules.
4. Extend the existing shared integration suite and representative whole-app journey. A feature is implemented once inside the composition; both pages exercise it through that owner.

Production diff target: roughly 150–250 existing lines moved and no more than about 200 new lines for the scope/reader API and adoption wiring, excluding tests and this document. Reassess the design before exceeding that estimate rather than adding another abstraction to accommodate every page flag.

## Evidence required before calling the structural repair complete

Use disposable signed messages in both registered pages to exercise person and agent mentions, profile navigation, edit/cancel/save, deletion with recovery, and reply-draft restoration. Keep the policy matrices in mounted tests: shared recovery across thread retargeting, no duplicate channel visit, forced-unread preservation, hidden-reader portal retirement, contribution removal, verified-root draft gating, and session recipient selection.

The browser journey must cover the actual page registrations and shared composition in Chromium and WebKit, including keyboard return focus and narrow presentation. Keep existing exact-target and channel-opening evidence to catch extra subscriptions, history reads, or reader remounts introduced by extraction. Browser fixtures prove their frontend/host contract, not packaged-native acceptance.

A passing mention journey or clean partial PR is not completion of this direction. Completion requires all current conversation surfaces using the same composition, removal of their duplicate assembly, and verified preservation of the merged editing and read policies.

## Current status

Revised October 14, 2026. `features/conversation/Conversation.tsx` implements the channel scope as `ConversationChannel`: it owns `MessageManagement` and its visit policy, and supplies session, scope, channel identity, extensions, and the interaction environment (page adapter or the shared dialog host) to `ConversationThread`, `ConversationTimeline`, and `ConversationComposer`. The Channels pane, conversation tabs, Inbox detail and channel preview, saved drafts, and embedded threads all use it, and their duplicated prop forwarding is removed. Saved drafts gain the editing/recovery scope they previously lacked, with `active={false}`.

Differences from the proposal above: pages still choose which reader to render, so a page can compose readers but cannot omit their shared dependencies. Dialog-hosted pages receive `MessageManagementStatus` from the channel scope; Channels places it within its own layout. `SessionsPage` still assembles its own timeline and composer and is the next adopter.
