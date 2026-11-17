# GitHub

Preview GitHub repositories, pull requests, issues, and commits without leaving Buzz.

## Getting started

1. Pull request and issue links in messages show their state as their icon,
   and a pasted one shows its repository, number and title, such as
   `buzz#42 · Fix the thing`, all kept current while shown. A pasted
   repository link shows `owner/repo` and a commit link `repo@abc1234`. Click any
   github.com link to open it in a side panel. In **Settings → Plugins → GitHub →
   Links**, turn off **Open GitHub links in Buzz** to open links and the linked-PR
   shortcut in your browser instead. This choice is saved on this device; pull
   request indicators and agent tools stay enabled.
2. On a pull request, switch between **Discussion** and **Checks**.
3. Switch a pull request from **Summary** to **Changes** to read its diff.
4. Choose **Open on GitHub** to see the full page.

5. To show a PR beside any conversation (including a read-only channel), open
   its PR panel there and choose **Show for me**. **Hide for me** removes it.
   This is personal to you on this device; existing shared Solo links remain.

---

## Conversation pull requests

The optional GitHub plugin can show a personal PR association on Team, DM and
Solo rows. Use **Show for me** in a PR panel opened from the conversation, or
`github_link_pr`. This device-local overlay is scoped to the signed-in person,
community and conversation. It works in read-only channels without sending a
message, joining the channel or changing shared metadata. **Hide for me** leaves
a manual-unlink record; a later automatic announcement cannot restore it.

After creating this conversation's own PR, an agent can call
`github_announce_pr` with its URL and exact head branch. The plugin verifies
GitHub authorship and branch before associating it automatically. The tool does
not post a message; announce the result separately if appropriate. Existing
personal choices and saved Solo links/unlinks win. Another PR requires an
explicit manual replacement. Incidental links, quoted messages and shell output
are never scanned or adopted.

Existing shared Solo links remain a fallback. Their panel actions and
`github_link_pr` with `shared: true` retain the original creator/writable-Solo
boundary. Personal overlays do not widen shared-write authority, synchronize to
other devices, or change what other channel members see. Saving a personal link
requires local storage and the browser's cross-window storage locks.

The sidebar keeps the PR lifecycle icon and adds separate checks, review,
review-thread and readiness indicators. Conflicts get their own signal. Unknown,
failed, stale or public-only reads cannot indicate merge readiness. “Ready on
GitHub” requires an open, clean, approved PR with settled passing checks and no
pending review requests or unresolved/unread review threads. It is not permission
to bypass your workflow’s approvals or merge policy.
