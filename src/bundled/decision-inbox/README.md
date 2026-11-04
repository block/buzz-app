# Decision Inbox

Keep Buzz messages that need your decision and a handoff in one place. Each item stays linked to its source message and is saved on this device for the current account and community.

## Getting started

1. Enable **Decision Inbox** in **Settings → Plugins → Manage plugins**.
2. Open a message's menu and choose **Save to Decision Inbox**. Enter the question and next actor.
3. Open **Decision Inbox** to see what needs a decision or handoff.
4. Use **Update** to record the decision and mark the handoff done. **Open source** returns to the message; **Remove** deletes a saved item after confirmation.

Unsaved edits remain available when you reopen the same message or item after changing pages while Buzz stays open. If Buzz cannot safely keep an edit, the dialog asks you to copy it before leaving. An identified cached session can read its saved decisions while disconnected; reconnect to change them.

**Unsaved drafts** shows captures whose source message is gone and edits whose saved decision was removed in another window. You can copy their text or discard them after confirmation.

Implementation invariant: only an explicit `clearViewScope` announces a purge. It awaits the same scope lock as Decision Inbox writes, deletes saved views, then advances a durable purge revision before releasing the lock. A write compares that revision inside the lock, so a queued first capture cannot recreate a purged list. If the lock is unavailable, saved views stay put and device cleanup reports a failure. If the marker cannot be written even after deletion frees space, cleanup reports a failure. The purge signal still clears in-memory drafts in this and other open windows when `BroadcastChannel` is available. If cross-window delivery is unavailable, the dialog does not retain an unsaved draft after navigation.
