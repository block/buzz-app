# Bestie

Bestie is the account-saved agent pinned in Buzz's left navigation. The
selection is the private `main-agent` record shared with Solo's default-agent
owner; this plugin adds presentation and a conversation destination, not another
selection store.

## Getting started

### Pinned conversation

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

The pinned row and Search Buzz destination show the agent's name and avatar.
Search adds **Bestie** as supporting text and matches either name, so the pinned
DM remains recognizable without presenting a placeholder identity. Agent rows
remain separate **New chat** actions; namesakes stay distinct by exact public key
and use readable owner labels before abbreviated-key fallbacks.

### Choosing a Bestie

The account choice is read before the page decides what to show. With a saved
Bestie, reconnecting, inventory failures and missing-agent states remain on the
pinned destination with their own recovery; they never fall through to the
chooser. A successful account read with no saved Bestie shows **Choose your
bestie**, where the owner can select an eligible existing agent or open the
shared **New agent** dialog. Choosing or creating an agent saves it through
`main-agent`, then hands off to the canonical DM.

Builderlab no longer owns a separate Bestie setup, agent, Solo chat, or
selection path.
