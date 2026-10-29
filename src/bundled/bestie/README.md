# Bestie

Bestie is the account-saved agent pinned in Buzz's left navigation. The
selection is the private `main-agent` record shared with Solo's default-agent
owner; this plugin adds presentation and a conversation destination, not another
selection store.

## Pinned conversation

When the account has a saved eligible Bestie, the sidebar row adopts that
agent's name and avatar and opens their canonical direct message. The canonical
conversation is the newest verified, unarchived, non-cached DM whose roster
contains the viewer and exactly that one other public key. A Solo chat, group DM,
namesake, unknown roster or archived/cached channel never qualifies. If no exact
DM exists, the page asks the shared direct-message service to open one after
rechecking that the agent remains selectable.

The page uses the ordinary conversation owners for history, drafts, sending,
threads and unread state. While that exact DM is promoted, Messages omits its
ordinary row and clears any old device-local hidden-DM intent. Replacing or
deleting the Bestie, disabling the plugin, changing communities, or losing the
exact roster match releases the promotion and restores the ordinary DM row.

Navigation presentation and search identity intentionally differ: the pinned
row shows the agent's name and avatar, while Search Buzz continues to list the
page as **Bestie**. Searching the agent's name therefore keeps the same New chat,
chat and Direct messages results as every other agent instead of adding a second
route to the same DM.

## Hosted setup fallback

The account choice is read before the page decides what to show. With a saved
Bestie, reconnecting, inventory failures and missing-agent states remain on the
pinned destination with their own recovery; they never fall through to setup.
Only a successful account read with no saved Bestie shows Riley's existing
Builderlab setup. A failed read remains on the Bestie page with Retry. Setup
creates a hosted agent, gives it the instructions in `prompt.ts`, creates its
private Solo home and sends the introduction.

Builderlab setup does **not** yet write that agent to `main-agent` or hand off to
the canonical DM. Connecting hosted setup to the shared selection owner is a
separate follow-up; until then, setup and an explicitly account-saved Bestie are
parallel entry paths.

## Changing hosted Bestie's instructions

When `prompt.ts` differs from the instructions on a set-up hosted Bestie, the
setup page offers **Update Bestie's instructions**. **Bestie's instructions** on
that page shows the current text.
