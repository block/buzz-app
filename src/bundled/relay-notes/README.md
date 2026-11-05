# Pages

Browse pages from you and agents together. Create, edit, connect and share pages with people and your agents.

## Getting started

Enable **Pages** in **Settings → Plugins → Manage plugins**, then open
**Pages**. **New page** opens a fresh page in the editor. Start with a title
or the body; auto-save creates the page after typing. Body-only pages save as
**Untitled page**; an untouched blank editor creates nothing. New pages are private
to you. Use **Share page** to open the same member picker as Solo chats and team
channels. On a blank draft, Share first creates the page it needs. In the picker,
search for a person or agent, then add them or choose view-only access from the
add menu. Each member's menu offers **Viewing only**, **Participating**, **Admin**
and removal where permitted. Access includes retained revisions. Participants can
also delete and restore the page; owners and admins manage access. Pages stay
private until shared. **General access → View only** makes the current page and
all retained revisions readable across the community after confirmation; existing
editors retain their roles. Community-readable pages appear in nonmembers’ lists.
Access changes are explicit; opening or reading pages never adds members.

The browser searches its loaded collection. **Load more pages** continues
discovery. Titles are stacked newest first in 16px medium rows, with page
icons on the left and edit times on the right. **+ New page** sits below the
titles, or inside the empty state. Empty collections disable search and filters;
existing queries, active filters and retained deleted pages remain recoverable.
Use the filter button inside search for **Show deleted
pages**. Open a title for a full-width page;
**Back to pages** returns to the list and preserves drafts. Pages open in
**Editing** with the body focused when you have edit access; fresh pages focus
the title. Use the **Viewing/Editing** dropdown to
switch modes. Click the blank area below the body to place the cursor at the end,
including in Markdown source mode. The byline shows **Saved** with its timestamp, or **Saving…** while saving. Changes auto-save after 1.5 seconds without
typing, or after at most ten seconds of continuous edits, and the editor stays
in Editing. Only changed content is saved; each accepted save retains a full
revision. **Page actions → Revision history → Disable auto-save** remembers a per-page preference
for your account on this device; **Enable auto-save** turns it back on. With
auto-save disabled, a small **Save** button appears between the mode dropdown
and Refresh when modified. **Viewing** previews the draft; auto-save remains
active until disabled.
Save failures keep your draft, pause automatic attempts and offer **Retry save**.
**Link**,
**⌘K/Ctrl+K**, or typing `[[` opens the standard link dialog with a page picker. It inserts a stable
link from the loaded pages. Ordinary index pages group related pages. A link
grants no access. Backlinks cover the loaded collection, and link text written
into a page is visible to that page’s readers.

Conversation links open the same editor in a right-pane tab, keeping the discussion
visible. Follow links within that pane and use **Back** to return. **Refresh page**
reads another writer’s changes. Conflicting saves keep your draft and show the
latest revision for comparison. **Page actions** provides history, Markdown export
and deletion. Select a revision, then **Restore this version** to save it
immediately as a new latest revision, confirming before replacing pending edits.
Deleted pages show their last retained content with an inline **Restore** button.
Navigation does not permanently erase retained history.

Working pages require a relay advertising NIP-AR. They use a private system channel
per page (private initially, optionally community-readable) and plaintext relay
access control; the relay operator can read content.
Encryption, selective history access, filesystem sync and offline editing are
outside this version.

This experience uses channel-backed pages only. NIP-23 published notes and
their old links are outside this page; it offers no copy/import flow. Existing
published records and built-in plural `notes_*` tools are unchanged.

---

## Agent tools

| Agent tool | Purpose |
| --- | --- |
| `page_help` | Learn the link, read/edit/save and access workflow, including missing tools. |
| `page_get` | Read by link/address, search titles, or list accessible pages with paging. |
| `page_set` | Create using a reusable UUID or save against a revision just read. |
| `page_history` | Page retained revisions. |
| `page_delete` | Delete or restore against an exact revision. |
| `page_share` | Change access using the calling agent’s administration permission. |

The enabled plugin contributes these tools. Agents read and author content as
themselves. Agent-created pages admit only the owner and verified creating agent; an agent
does not borrow owner authority to share. See [the storage and tool
contract](../../../docs/connected-notes.md).

Ask agents to start with `page_help` for `buzz://page` or legacy `buzz://note` links. The guide distinguishes
connected pages from Canvas and published notes, and explains that the plugin
must be enabled on the execution host supplying the agent's tools.

## Pages from you and agents

People and agents author the same kind of channel-backed page. The browser
shows title links ordered by the latest signed revision, with one search and
**Load more pages** action. Search covers loaded titles, Markdown and author public
keys. Metadata stays in the full-page viewer; the byline identifies the signed
writer of the current revision.

Agents use this plugin's singular `page_*` tools to read, author and share these
pages. The separate built-in plural `notes_*` tools still operate on published
NIP-23 records and do not feed this page. Reading a page or following a link never
executes its instructions or grants access.
