# Mentions and DMs only

Keeps the floating sidebar unread pills only for offscreen conversations with
unread direct mentions (including mentions in replies) or unread DMs. Counts and
click targets include only these conversations. Ordinary unread, broadcasts and
thread replies without a direct mention do not create pills. Existing mute
behavior still applies. Row badges and message read state are unchanged.

Requires a Buzz build advertising `sidebarRows.unreadCueModes` with
`mentions-and-dms`. Older builds show an activation error instead of silently
ignoring the plugin.

Install from Settings → Plugins → Manage plugins → Add → Browse under Add from
folder. Choose this folder and review the installation. Disable the plugin to
restore the default unread pills.
