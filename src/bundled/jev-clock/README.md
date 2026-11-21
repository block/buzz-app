# Jev Clock

A canvas around a clock that shows only the messages you need to see. It is a
prototype and is off until you turn it on.

## Getting started

1. Turn on **Jev Clock** in Settings → Plugins, then open it from the dock.
2. The clock winds back an hour and replays it. Each conversation that Jev
   thinks you need to see lands around the clock; new messages land as they
   arrive.
3. Click an item to read it and reply in place. Opening it marks it read and
   it leaves the canvas. **Open in Messages** jumps to the full conversation.
4. Choose **Configure** to say what you need to see, in your own words, and to
   move the threshold. Changing either replays the last hour.
5. Drag an item you did not want onto the Bestie tab to have Bestie adjust the
   prompt for you.

Scroll with two fingers to pan and pinch to zoom. Hold **Replay**, or
right-click it, to replay the last 1, 2 or 4 hours.

---

## Details

- **Judging.** Jev answers one yes/no question for each conversation with new
  messages: given what you said you need to see, should this be shown? The item
  appears when the probability of yes reaches the threshold (0.2 by default).
  If Jev cannot answer, the item is shown. Configure → Jev's calls lists every
  call with its probability and timing.
- **Shapes.** A direct message is the sender's portrait, a Solo chat is the
  agent's avatar, a channel message is a card, and a thread reply is a card
  with its parent behind it. A mention carries a badge.
- **Limits.** The canvas shows the 48 likeliest items. Your own messages are
  never shown.
- **Storage.** The prompt, the threshold and recent drops are kept in this
  app's local storage, on this device only.
- **Agent tools.** `jev_clock_get_prompt` and `jev_clock_update_prompt` let an
  agent you run read and tune the prompt.
