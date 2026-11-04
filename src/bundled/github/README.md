# GitHub

Preview GitHub repositories, pull requests, issues, and commits without leaving Buzz.

## Getting started

1. Pull request and issue links in messages show their state as their icon,
   and a pasted one shows its repository, number and title, such as
   `buzz#42 · Fix the thing`, all kept current while shown. Click any
   github.com link to open it in a side panel. In **Settings → Plugins → GitHub →
   Links**, turn off **Open GitHub links in Buzz** to open links and the linked-PR
   shortcut in your browser instead. This choice is saved on this device; pull
   request indicators and agent tools stay enabled.
2. On a pull request, switch between **Discussion** and **Checks**.
3. Switch a pull request from **Summary** to **Changes** to read its diff.
4. Choose **Open on GitHub** to see the full page.
5. To post a repository's pull requests in a channel, open the channel menu,
   choose **GitHub repositories** and follow the repository. Add the webhook it
   shows (payload URL, secret, `application/json`, and the pull request,
   review, check suite, check run and status events) in the repository's
   settings on GitHub. The secret is shown once; **Regenerate secret** makes a
   new one. Following needs the desktop app.
6. Pull requests the community follows show as a card in the channel and
   their links stay current from the community, without `gh`.
