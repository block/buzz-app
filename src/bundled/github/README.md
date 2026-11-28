# GitHub

Preview GitHub repositories, pull requests, issues, and commits without leaving Buzz.

## Getting started

1. Pull request and issue links in messages show their state as their icon,
   and a pasted one shows its repository, number and title, such as
   `buzz#42 · Fix the thing`, all kept current while shown. With the `gh` CLI
   signed in, an open pull request's icon gains a check badge once it has
   every approval its repository requires, such as a code owner's. Where the
   repository requires none, any approval shows the badge, unless a later
   review requested changes. A pasted
   repository link shows `owner/repo` and a commit link `repo@abc1234`. Click any
   github.com link to open it in a side panel. In **Settings → Plugins → GitHub →
   Links**, turn off **Open GitHub links in Buzz** to open links and the linked-PR
   shortcut in your browser instead. This choice is saved on this device; pull
   request indicators and agent tools stay enabled.
2. On a pull request, switch between **Discussion** and **Checks**.
3. Switch a pull request from **Summary** to **Changes** to read its diff.
4. Choose **Open on GitHub** to see the full page.
5. To post a repository's pull requests in a channel you can post in, open
   the channel menu, choose **GitHub repositories** and follow the repository.
   Following needs the desktop app with `gh` signed in: your Buzz reads the
   repository about once a minute and posts its pull requests as you, so
   cards only update while your Buzz is open. New cards start only for pull
   requests that change after you follow. Anything it can't keep shows under
   the repository.
6. Each followed pull request shows as a card on its announcement, with its
   state, checks and reviews, and the thread gets a reply when it is
   approved, merged or closed. A card shows only what the repository's
   publisher wrote, and only while the channel still follows the repository
   with them as its publisher.
