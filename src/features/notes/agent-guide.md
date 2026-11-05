# Pages: agent guide

Use this plugin for the working pages shown in Buzz's Pages workspace, including
links starting with `buzz://page` or legacy `buzz://note`. Start with `page_get` and save with `page_set`.
These pages are not a channel's Canvas or messages. The built-in plural
`notes_get`, `notes_set` and `notes_rm` handle a separate published-note format;
an empty result there says nothing about a connected page.

## Open a shared link

Both link forms have three query parameters: `community`, `channel` and `id`. Decode the
parameters as URL query values. The `channel` is the backing channel UUID and
`id` is the page UUID; neither is a published-note name or message ID.

1. Check the link's community against the community of this agent conversation.
   Do not assume a link switches communities. If they differ, use a conversation
   in the page's community; access still requires membership or sharing there.
2. Pass the complete link to `page_get`; it validates the address and community:

   ```json
   {"url":"<complete buzz://page or buzz://note link>"}
   ```

3. Read its `markdown`, `title`, `deleted` and `revision`. A deleted page's
   current content is empty; use `page_history` for retained contents.
4. Apply the requested edit and call `page_set` with the returned `id` and `channel`, the exact
   revision just read, the title and the full replacement Markdown:

   ```json
   {"id":"<id from page_get>","channel":"<channel from page_get>","revision":"<revision from page_get>","title":"Page title","text":"Full updated Markdown"}
   ```

   Supply exactly one of `text` or a local UTF-8 `path`. Never omit `channel`
   when editing: omitting it requests creation, not an update.
5. If the revision changed, read again and reconcile the requested edit with the
   latest content. Do not overwrite a newer revision blindly. Verify the saved
   result with `page_get` before reporting the update. A conflict error does not
   store your proposed text as an app draft; keep it in your working context.

## Other operations

- **Find pages by name:** `page_get` with `q: "title words"` searches titles
  without case sensitivity. With no arguments it lists accessible pages. Results
  are in `pages`, with a link for each match. When `more` is true, pass the
  returned `cursor` and the same `q` to continue; a search page is not the complete
  collection. Read the chosen result by link before editing. If multiple titles
  match, confirm which page is intended. An empty first
  page does not replace a direct lookup when the person supplied a full link.
- **Create:** `page_set` with a new UUID `id`, a `title` and `text` or `path`;
  omit `channel` and `revision`. Reuse the same UUID on retries. Initially only
  the owner and verified creating agent have access. The creating agent has
  editing access, not Admin. The owner can share the page, or grant the agent
  **Admin** using the **Share page** dialog before asking it to share.
- **History:** `page_history` with `id` and `channel`; use the returned paging
  information. To restore an older live version, save its title and Markdown
  with `page_set` against the current revision.
- **Delete:** `page_delete` with `id`, `channel` and the current `revision`.
  Deletion is recoverable; it does not permanently erase history.
- **Restore a deleted page:** read retained content with `page_history`, then
  call `page_delete` with the current address/revision, `restore: true`, `title`
  and `text` containing the chosen retained contents.
- **Share:** `page_share` with `id`, `channel`, `pubkey` and
  `access: "read" | "edit" | "remove"`. This requires the calling agent's
  administration permission. Editing access alone does not allow sharing.
  If needed, ask the owner to grant this agent **Admin** in **Share page**.
  Recipients can read retained history too.

## Missing tools or access

The device running the agent must have a build with Pages enabled to
supply these plugin tools. Sharing the page does not install tools on another
execution host. If `page_get` is absent from the available tools, report that
specific limitation and ask the owner to update/enable the plugin on that host.
Do not substitute Canvas or published-note tools and conclude that the page
is empty. If the tools are present but access fails, check the conversation's
community and the agent's own sharing role. The tools use the calling agent's
identity; a link never grants access or borrows the owner's authority.
