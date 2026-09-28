import { verifyEvent, type Event } from "nostr-tools";

// Structured clone drops nostr-tools' cached verification symbol, so every
// event here is hashed and Schnorr-checked from its wire fields.
self.onmessage = (event: MessageEvent<Event[]>) => {
  const started = performance.now();
  const ok = event.data.every((item) => verifyEvent(item));
  self.postMessage({ ok, ms: performance.now() - started });
};
