# Catch up

## Getting started

Opt-in unread conversation triage. Enable **Catch up** in Settings → Plugins,
then open **Catch up** from navigation.

Swipe right to mark read, or left to keep unread. Use touch, horizontal trackpad
gestures, or drag the card header with a mouse. Vertical scrolling and selecting
preview text do not swipe cards; the buttons also work with the keyboard. Each
trackpad gesture acts on one card, including its trailing momentum.

Each card shows the conversation's latest available preview and observed unread
count. Previews do not create a reading lease or mark messages seen. **Keep
unread** skips a conversation until **Check again** or leaving the page. **Mark
as read** uses the shared channel read operation, including replies; failures
leave the card available for retry. **Open conversation** uses the normal reader,
where normal reading behavior applies.

The page uses existing channel and unread subscriptions and the shared bounded
unread repair. It adds no polling or per-channel history reads. Counts are
observed recent evidence, not exact totals. Archived, cached-only, unjoined and
Huddle channels are excluded. The plugin requires no external service or grants.
