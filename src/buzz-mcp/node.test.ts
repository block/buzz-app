import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bytesToHex } from "nostr-tools/utils";
import { keypair, signed } from "../features/relay/testing";
import { nodeClient } from "./node";

const agent = keypair();
const owner = keypair();
let stored: unknown[];
let response: (() => unknown) | undefined;

// A community that keeps what is posted and answers every query with all of it.
beforeEach(() => {
  stored = [];
  response = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/events")) stored.push(JSON.parse(String(init.body)));
      const body = url.endsWith("/events")
        ? { accepted: true }
        : (response?.() ?? stored);
      return new Response(JSON.stringify(body));
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const client = () =>
  nodeClient({
    relay: "wss://relay.test",
    key: bytesToHex(agent.secret),
    auth: JSON.stringify(["auth", owner.pubkey, "", "0".repeat(128)]),
    root: "/",
  });
const message = signed(owner, { kind: 9, content: "hi", tags: [["h", "c"]] });

it("returns verified events from a query", async () => {
  response = () => [message];
  expect(await client().query([{ kinds: [9] }])).toMatchObject([
    { id: message.id, content: "hi" },
  ]);
});

it.each([
  ["a forged signature", () => [{ ...message, sig: "0".repeat(128) }]],
  ["edited content", () => [{ ...message, content: "bye" }]],
  ["a malformed record", () => [{ ...message, pubkey: "me" }]],
  ["a non-array body", () => ({ events: [message] })],
])("rejects a query answered with %s", async (_, body) => {
  response = body;
  await expect(client().query([{ kinds: [9] }])).rejects.toThrow(
    /malformed or invalidly signed|not an event array/,
  );
});

it("reads back its memory and rejects a tampered entry", async () => {
  const buzz = client();
  await buzz.remember("mem/notes", "keep this", 0);
  expect(await buzz.memories()).toMatchObject([
    { slug: "mem/notes", body: "keep this" },
  ]);

  // The newest head would win if its signature went unchecked.
  const entry = stored[0] as { created_at: number };
  stored.push({ ...entry, created_at: entry.created_at + 1 });
  await expect(buzz.memories()).rejects.toThrow(/invalidly signed/);
});
