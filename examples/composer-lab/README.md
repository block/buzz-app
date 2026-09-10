# Composer Lab

Ready to install: select this folder in desktop Settings → Plugins, then enable
**Composer Lab**. `manifest.json` and prebuilt `plugin.js` are included; no build is
required. Use the matching host branch with the conversation capability.

An independent API-v1 plugin consuming `ctx.conversation.ui.Composer` and `.Message`
and the existing relay session. It also contributes a non-emoji timestamp tool to
all shared composers. No Channels/Emoji implementation or host runtime import.

For source changes only: copy this folder outside the host checkout, install the host-matched packed
`@buzz/author` preview with `pnpm add -D /absolute/path/buzz-author-VERSION.tgz`,
then `pnpm build`. Install the resulting `dist` folder through desktop Settings
or `buzzodz plugin install`. Refresh the checked-in `plugin.js` from that build
when changing the example source. New installs start disabled.

This example uses real current-session data: sending posts to the selected channel. Notes and
Counter remain separate offline examples. Preview API/version compatibility is
not guaranteed across hosts; this plugin requires the conversation capability.
