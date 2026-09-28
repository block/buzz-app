import { verifyEvent, type Event } from "nostr-tools";

// Structured clone drops nostr-tools' cached verification symbol, so every
// event here is hashed and Schnorr-checked from its wire fields.
self.onmessage = (event: MessageEvent<{ id: number; events: Event[] }>) => {
  const started = performance.now();
  const ok = event.data.events.every((item) => verifyEvent(item));
  self.postMessage({ id: event.data.id, ok, ms: performance.now() - started });
};
