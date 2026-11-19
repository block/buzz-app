# TypeSafe

Answers the app's decisions with your own TypeSafe API key. Attention uses
decisions to check which events should wake an agent.

## Getting started

1. Open **Settings > Decisions API** and select **TypeSafe** for a community.
2. In that community's row, follow the [TypeSafe console](https://console.typesafe.ai/keys) link to create a key, then paste it and choose **Save**.

Each community has its own key. A key saved before keys were per community
is given to each community joined then, the first time Buzz starts.

Buzz keeps each key in this Mac's Keychain, or this device's credential store.
It is never shown again, and it is never given to an agent or a plugin.

The saved key stays masked. Use its chevron menu to **Replace** or **Remove** it.
Replacement starts blank and masked, with inline **Cancel / Save** controls.
**Remove** asks for confirmation before deleting that community's key from
this device; other communities keep theirs.
Settings cannot reveal or copy the saved key.
