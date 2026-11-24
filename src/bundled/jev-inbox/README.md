# Jev Inbox

An inbox that shows only the conversations Jev thinks you need to see, newest on
top, with one-line summaries from Bestie for longer threads and channels. It is
a prototype and is off until you turn it on.

## Getting started

1. Turn on **Jev Inbox** in Settings → Plugins, then open it from the dock.
2. It reads the last hour of messages and judges each conversation. The ones
   Jev thinks you need to see land as cards in the column, and new arrivals
   spring in on top (or count up in a pill while you are scrolled down).
3. Click a card to read and reply in place. Opening or clearing a card marks
   its messages read and removes it from the inbox. **Open in Messages** jumps
   to the full conversation.
4. Choose **Configure** to say what you need to see, in your own words, and to
   move the threshold. Changing the wording re-judges the last hour; moving the
   threshold re-filters right away.
5. Click **Chat** on a card to send Bestie a note about it so Bestie can tune
   the prompt for you.

Filter by **Inbox**, **Messages**, **Threads** or **Channels** at the top. Hold
the reload button, or right-click it, to replay the last 1, 2 or 4 hours.

---

## Details

- **Judging.** Jev answers one yes/no question for each conversation with new
  messages: given what you said you need to see, should this be shown? A card
  appears when the probability of yes reaches the threshold (0.2 by default),
  or when Jev cannot answer. Configure → Jev's calls lists recent calls with
  their probabilities and timing.
- **Summaries.** Jev also asks whether a thread or channel conversation is long
  enough to summarize. When a Bestie is configured, Jev Inbox wakes Bestie in
  its DM with up to six conversations as data, and Bestie answers through
  `jev_inbox_summarize` without posting a message. Cards wait for judging and,
  when summarizing, up to 45 seconds for their summary before landing together.
- **Limits.** The inbox shows the 60 newest matching conversations. Your own
  messages are never shown.
- **Storage.** The prompt, the threshold and recent feedback notes are kept in
  this app's local storage, on this device only. When Jev Clock has already
  saved a prompt here, Jev Inbox starts from it.
- **Agent tools.** `jev_inbox_get_prompt`, `jev_inbox_update_prompt` and
  `jev_inbox_summarize` let Bestie read and tune the prompt and answer summary
  wakes.
