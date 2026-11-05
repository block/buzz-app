# Connected working pages

The bundled `buzz.relay-notes` plugin owns one channel-backed Pages browser and contributes one
page panel plus six agent tools. `features/notes` owns the shared protocol
model and channel orchestration. Existing session reads, channel creation,
membership operations, signing and panel routing retain their authority; there is
no separate pages backend or local mirror.

## Storage and sharing

A working page is a kind-45010 NIP-AR artifact with immutable `type=buzz.note`, a
UUID `d`, its home channel `h`, and Markdown content. `note=1` identifies this
app’s editable payload version. Saves are complete snapshots with a required
`prev` for updates, deletion and restoration. The relay’s accepted head defines
the current version, including a deletion head; event timestamps do not choose it.
The optional `root` is a conversation anchor in the home channel, never a page
revision ID. Standalone pages omit it; edits, deletion and restoration preserve
an existing anchor. Only `prev` links the artifact's revisions.
Unknown payload versions remain readable, and unrelated tags survive edits.
Deletion publishes only the artifact envelope; history restoration preserves the
chosen revision’s annotations. Titles are limited to 512 UTF-8 bytes and bodies
to 32 KiB, with an additional complete-frame bound.

Each independently shared page has one **system** channel, initially private, labelled
`buzz.notes` and `buzz.notes.<page-uuid>`. A human-created page initially admits
only its creator; an agent-created page admits the owner and that creating agent.
Other people and agents are invited explicitly. Existing memberships remain;
the retired `buzz.notes.agents` label is recognized only for compatibility and
never triggers membership changes. Labels describe storage, never membership
authority. Sharing reads fresh relay-signed 39000/39001/39002 state and refuses a
channel containing another artifact, including another artifact’s deletion head.
Readers enter directly as `guest`; editors use `member` (owned agents may be
`bot`). Editors can delete/restore. Channel role semantics still apply; the app
does not promise that an editor cannot send invitations through another client.

**Share page** uses the current `ChannelMembersDialog` search, filters, identity
rows, role menus and confirmations. Pages expose **General access → View only**
through the shared channel-details owner. Anyone in the community can then read
the page and all retained revisions; a confirmation states that consequence.
Existing editors keep their access. **Private** restricts reading to explicit
members again. Pages do not offer community participation. Membership and general
access changes pass through NotesWorkspace's independent-page and administration checks; a confirmation's expected role must
match a fresh roster before any write. The UI supports explicit admin access;
the singular agent tool's read/edit/remove contract is unchanged. The dialog's
Copy link action uses the page URL rather than opening its backing channel.

Opening, listing or reading a page never changes membership. Human page creation
requires no agent inventory or owner attestations. When an agent explicitly
creates a page, the coordinator checks that caller against `session.agentChoices`
and its latest signed NIP-OA owner attestation before allocating storage, then
admits only that agent. An unrelated unverified agent cannot block creation.
No profile or attestation is repaired or overwritten by this flow.

Channel read permission covers current content and retained history. Contents
are plaintext to the relay operator. Encryption and selective-history permissions
are outside this format. Links and index pages confer no access. Written titles
inside link text are ordinary source-page content.

## Reads, discovery and recovery

The connection must advertise `nip-ar` before artifact writes are offered. Named
kind-45010 `#h`/`#d` queries retrieve current heads, including tombstones. History
uses the HTTP query contract’s `artifact: history`; it must be a single filter
and must not include `consistency`. History pages contain 100 revisions, through
offset 10,000; reaching the bound is disclosed.

Discovery pages relay-signed system metadata readable by the viewer, filters the
independent page labels and private or public+guest policy, then reads named artifact
heads. Community-readable pages appear in nonmembers' Pages lists without joining. It does not subscribe to every page
as a conversation. Search, link pickers and backlinks cover loaded pages only;
the browser offers further pages. This avoids a silent first-page completeness
claim, but is not a measured thousand-channel capacity guarantee.

Agent creation verifies its caller before allocating storage. The caller
supplies a UUID and reuses it on retry. The owner’s signed creator/label lookup
finds an already-created channel, then checks the current artifact before
retrying the first snapshot. A changed page is never overwritten during
recovery. Failed creation can leave an empty private system channel; retry the
same UUID. Empty-channel deletion and retention-policy administration remain
ordinary channel operations. Deleting a page retains its channel and membership.

Updates compare the revision read by the editor, publish `prev`, and confirm the
accepted head. Relay conflict refusals fetch the newer version for comparison.
The editor preserves the draft, including when access changes; fresh reads that
fail withhold the cached page and remove it from the local catalogue. Initial
roster discovery can invalidate a concurrent session read; only that cancelled
read is retried once. Writes are never retried automatically.

## Agent tools

The singular tools operate on NIP-AR pages, separately from legacy plural
`notes_get`, `notes_set` and `notes_rm`. A connected owning app supplies the
coordinator. Ordinary reads and content writes use the calling agent’s own client
and identity. The owner’s coordinator allocates new storage and admits only the
verified creating agent on its explicit creation request. Sharing never borrows
the owner’s writer or administration role.

| Tool | Inputs and result |
| --- | --- |
| `page_help` | No arguments; read the bundled agent guide for links, editing, access and missing-tool setup. |
| `page_get` | `url` or `id, channel` for a page; `q` searches titles, omit all to list. Continue search/list pages with the returned `cursor` and the same query. |
| `page_set` | `id, title` and exactly one of `text, path`. For creation omit `channel, revision`; for editing supply both. |
| `page_history` | `id, channel`, optional `offset` in the advertised page range. |
| `page_delete` | `id, channel, revision`; restore with `restore=true, title, text`. |
| `page_share` | `id, channel, pubkey, access=read|edit|remove`; requires the caller’s administration role. |

Content results include UUID, channel, exact revision, title, deletion state,
Markdown and a community-bound link. For a deleted page use `page_delete`
with `restore=true`; `page_set` updates a live page. History results include
the retained snapshots and whether more remain.

Existing `buzz://note` page links and legacy `view=note` routes remain accepted; new links use `buzz://page` and new editor routes use `view=page`. Stored artifact types, labels, plugin/page IDs and local save preferences retain their existing identities.

## Page editing

**New page** opens a blank page in the same centered editor, with a heading
input, rich-text body and formatting dock. Storage is allocated only after typing
and the first save; body-only pages use **Untitled page**. New-page actions offer
source mode and a Revision history submenu containing the auto-save toggle. **Share page** explicitly creates an empty
untitled page if necessary, then opens the same member picker as existing pages.
Drafts stay mounted across Back/Forward; inactive drafts do not begin auto-saving.
First-save completion replaces the creation address, preserves edits made in
flight and restores the active title/body selection. An in-flight completion
while browsing updates the collection without navigating away. Creation retries
reuse the original UUID and attempted payload, preserving subsequent edits as
a draft against the accepted first revision.

The Viewing/Editing selector controls the page mode. New visits default to
Editing for editable pages and focuses the body on entry; explicit Viewing/Editing history choices remain
authoritative. Read-only and deleted pages keep their reader presentation, and
retained drafts remain available after access changes. Editing reveals the
formatting list directly, without a formatting toggle. Both modes keep the same
title and body alignment; the body has no additional editor border or padding.
The toolbar is pinned in an inset pane-bottom floating surface outside the
page scrollport while Editing, with no reserved gap in Viewing. Its natural
height keeps page content clear when controls wrap or text grows.
The hidden editor retains its selection and undo state. Viewing previews the
current draft; auto-save remains active unless disabled.
An unmodified primary click on the blank scrollport below the page body
focuses the active formatted/source editor at its end. Text, title and control
clicks retain their own behavior; Viewing and read-only pages do not activate
an editor. Keyboard users reach the existing textbox with Tab.
The byline uses one status phrase: Saved with its timestamp when clean,
Saving… for queued/in-flight auto-saves, or Save paused on failure. Human
avatars are circles; agents retain squircles. Empty drafts have no status hint.
Auto-save is enabled by default. Changed title/body content is saved after a
1.5-second idle period, with a ten-second maximum during continuous edits; IME
composition defers saving until composition ends. Auto-save stays in Editing and
typing remains available during the request. The accepted revision becomes the
next save's base without replacing newer edits made in flight. Local live echoes
are reconciled after the save receipt. Clean remote updates are adopted, while a
dirty draft requires comparison before a concurrent revision can be overwritten.
Failures pause automatic attempts, retain the draft and offer Retry save.

Page actions → Revision history offers Disable auto-save / Enable auto-save, persisted through the
existing scoped view store for this account, community and page on this device.
This is a local editing preference, not shared page metadata. When disabled,
a small prominent Save action appears after Viewing/Editing and before Refresh
while modified, using motion/react for its enter/exit with reduced-motion and
keyboard transitions kept immediate. Clean pages show no Save action.
Revision history is a Page actions submenu with paged retained versions. Selecting a
version opens its addressable preview. Restore this version saves immediately as
a new latest revision, including with auto-save disabled; pending edits require
confirmation. Queued auto-save pauses while a revision preview is open. Failed restoration
keeps the prior draft and preview; CAS conflicts require comparison. Deleted pages
use the same explicit action.
`NoteEditor` reuses `EditableInput`, `ComposerFormattingTools`, `ComposerLinkDialog`
and the composer's ProseMirror schema/commands. Enter inserts a newline. There are
no chat send, recipient or attachment controls.
The standard Link action and Mod-K accept a URL or a loaded page; `[[` uses the
same dialog. Page destinations retain their stable community/channel/page URL.

Markdown remains the persisted format. The page-owned importer restores supported
inline formatting, lists, quotes and code into the existing schema. Unsupported
blocks, including headings and tables, remain editable Markdown source rather
than being discarded. **Page actions → Markdown source** opens source editing;
**Formatted text** in the same menu returns to the formatted editor. Source mode
fills the remaining page height and uses body-sized monospaced text. The
formatting bar hides in source mode. An untouched editor does not normalize the
original page. Rich edits use the shared
serializer; source spelling of supported constructs may normalize.

The browser lists linked page titles in newest-revision order as rows without dividers,
with 16px medium titles, no underlines and a subtle page icon before each title. The last edit time sits at the far right. There are no
card previews or author folders. A subtle **+ New page** action follows
the page titles. Empty collections put the creation button inside the empty state;
search is disabled until there are pages, unless a query needs clearing. **Show
deleted pages** lives in the search field's trailing filter menu, retaining the
existing history-backed filter state.
The filter disables only when no pages are loaded and it is inactive; retained
deleted pages keep it available even when the visible list is empty.
Author and revision metadata remain in the page viewer. The list, page content and formatting bar share the channel
timeline/composer's centered 52rem maximum width and shrink to fit narrow panes.
Pages retain the shared reader's heading, author/avatar and update byline,
page spacing, scrollport and Markdown styles, alongside access notices,
sharing, revision history, backlinks and draft actions.
When the loaded collection contains backlinks, **Page actions → Linked pages**
shows their source titles. Its submenu retains partial-collection guidance when
more pages remain to load; pages without loaded backlinks omit the action.

## Navigation and compatibility

`buzz://page?community=<https-origin>&channel=<uuid>&id=<uuid>` binds a page
to its community and stable identity. The shared parser is used by chat,
Markdown and OS ingress. Opening a title replaces the collection with a full-width
page view at every screen size. **Back to pages** returns to the same search and
collection without discarding drafts. Loaded editors stay mounted across these
visits. The full view uses the same page/editor as the channel’s right-pane
panel; conversation links still open beside the discussion. Both use the existing
browser-history driver.
Pages-page destinations record the selected page, committed search, deleted-page
filter, editing mode, share/link/delete/history dialog, selected revision and
history page. New-page destinations contain a draft identifier and open the
page editor directly, without a creation modal. Conversation
destinations optionally carry the same page presentation; Back/Forward restores
linked pages and their editor state without leaving the conversation.
The host applies page restoration after restoring its conversation tab visit.
Conversation page tabs use the same visit-retirement owner as Profile/GitHub
tabs: Back/Forward retains a return path, while closing a tab or closing all/other
tabs retires the closed pages' visits. Closing an inactive page preserves the
selected tab. Collapsing the tab pane changes layout without creating a visit.

History contains addresses and presentation only, never draft titles or bodies.
Unsaved page drafts and new-page drafts survive Back/Forward in the current
session; refreshing or restarting is not offline draft persistence. Replaying a
destination reads current permissions and does not repeat a save, share, delete
or restore. Earlier channel-backed `{id, channel}` addresses remain accepted.

This experience handles only channel-backed NIP-AR pages, regardless of whether
a person or agent authored them. It does not query, display, copy or import
NIP-23 published notes. Old published-note routes are no longer accepted by this
page. Existing published records and the separate built-in plural `notes_*`
tools are unchanged; there is no migration or deletion of those records.
Signed current-revision authors provide page bylines; this is not a new
claim about the original creator after collaborative edits. Discovery, pagination
and read authority belong to the existing NotesWorkspace owner.

## Verification boundary

`features/notes/model.test.ts` exercises signed state, owner attestations,
permissions, CAS, partial creation, pagination and human/agent publication using
real sessions and outboxes with an in-memory upstream. The Chromium/WebKit
`working-notes.spec.mjs` journeys use the registered production plugin and channel
workspace to cover editing, conflict dialogs, links, sharing, export, restoration,
NIP-23 separation and the conversation right-pane layout. The affected native
package separately tests artifact signing, including the strict deletion envelope
without chat `ms`.

These checks do not establish a packaged-native live-relay round trip, OS delivery,
or capacity at thousands of page channels. Those require an agreed isolated
identity/data setup; no existing pages or production membership need be changed
to run the fixtures.
