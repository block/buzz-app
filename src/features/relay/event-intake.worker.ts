import { checkResponse, createProofMemo } from "./event-checks.ts";

// A proof is valid for its exact signed bytes whichever connection read them.
const proven = createProofMemo();

self.onmessage = (message: MessageEvent<{ id: number; text: string }>) => {
  const { id, text } = message.data;
  self.postMessage({ id, checked: checkResponse(text, proven) });
};

// Tells the main thread this module has loaded and can take reads.
self.postMessage({});
