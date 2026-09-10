# Composer Lab

An independent API-v1 plugin consuming `ctx.conversation.ui.Composer` and `.Message`
and the existing relay session. It also contributes a non-emoji timestamp tool to
all shared composers. No Channels/Emoji implementation or host runtime import.

Copy this folder outside the host checkout, install the host-matched packed
`@buzz/author` preview with `pnpm add -D /absolute/path/buzz-author-VERSION.tgz`,
then `pnpm build`. Install the resulting `dist` folder through desktop Settings
or `buzzodz plugin install`. New installs start disabled.

See [the host's laptop walkthrough](../../docs/emoji-plugin.md). This example uses
real current-session data: sending posts to the selected channel. Notes and
Counter remain separate offline examples. Preview API/version compatibility is
not guaranteed across hosts; this plugin requires the conversation capability.
