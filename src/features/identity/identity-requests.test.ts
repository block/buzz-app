import { expect, it } from "vitest";
import {
  createIdentityRequests,
  identityAnswerUrl,
  parseIdentityRequest,
} from "./identity-requests";

const pubkey = "cd".repeat(32);
const state = "A".repeat(43);
const callback = "https://app.example.org/buzz/callback?from=settings";
const link = (fields: Record<string, string>) =>
  `buzz://authorize-identity?${new URLSearchParams({ version: "1", pubkey, callback, state, ...fields })}`;

it("reads the key, the https callback and its origin", () => {
  expect(parseIdentityRequest(link({}))).toEqual({
    pubkey,
    callback,
    origin: "https://app.example.org",
    state,
  });
});

it.each([
  ["another version", link({ version: "2" })],
  ["an uppercase or short key", link({ pubkey: pubkey.toUpperCase() })],
  ["a short key", link({ pubkey: "cd" })],
  ["a guessable state", link({ state: "abc" })],
  ["a plain http callback", link({ callback: "http://app.example.org/cb" })],
  [
    "a callback with credentials",
    link({ callback: "https://u:p@app.example.org/" }),
  ],
  [
    "a callback with a fragment",
    link({ callback: "https://app.example.org/#x" }),
  ],
  ["a loopback-style scheme", link({ callback: "buzz://channel/general" })],
  ["an unknown parameter", `${link({})}&scope=agent`],
  ["a repeated parameter", `${link({})}&state=${state}`],
  [
    "another link host",
    link({}).replace("authorize-identity", "mcp-authorize"),
  ],
])("refuses %s", (_, raw) => {
  expect(parseIdentityRequest(raw)).toBeNull();
});

it("answers in the callback's fragment, never its query", () => {
  const request = parseIdentityRequest(link({}));
  if (!request) throw new Error("expected a request");
  const proof = ["auth", "ab".repeat(32), "", "ef".repeat(64)];
  const approved = new URL(identityAnswerUrl(request, { proof }));
  expect(approved.search).toBe("?from=settings");
  const fragment = new URLSearchParams(approved.hash.slice(1));
  expect(fragment.get("state")).toBe(state);
  expect(JSON.parse(fragment.get("proof") ?? "")).toEqual(proof);
  const denied = new URLSearchParams(
    new URL(identityAnswerUrl(request, "denied")).hash.slice(1),
  );
  expect(Object.fromEntries(denied)).toEqual({ state, error: "access_denied" });
});

it("keeps one request at a time, the newest", () => {
  const requests = createIdentityRequests();
  const first = parseIdentityRequest(link({}));
  const second = parseIdentityRequest(link({ state: `${"B".repeat(42)}A` }));
  if (!first || !second) throw new Error("expected requests");
  let changes = 0;
  requests.subscribe(() => changes++);
  requests.open(first, "ab".repeat(32));
  const firstId = requests.snapshot()?.id ?? 0;
  // The same link opened again is a separate decision.
  requests.open(first, "ab".repeat(32));
  const againId = requests.snapshot()?.id ?? 0;
  expect(againId).not.toBe(firstId);
  requests.close(firstId);
  expect(requests.snapshot()?.id).toBe(againId);
  requests.open(second, "ab".repeat(32));
  expect(requests.snapshot()?.request).toBe(second);
  requests.close(requests.snapshot()?.id ?? 0);
  expect(requests.snapshot()).toBeNull();
  expect(changes).toBe(4);
});
