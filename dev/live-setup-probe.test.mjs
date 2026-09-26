import { afterEach, expect, it, vi } from "vitest";
import { generateSecretKey } from "nostr-tools";
import { parseStrategy, probe, runStrategy } from "./live-setup-probe.mjs";

afterEach(() => vi.useRealTimers());
/** A relay 20 ms away that answers every REQ at once and caps filters at 10.
 * `answer` may replace the reply to a channel REQ (or return null for none). */
function fakeRelay(answer = (id) => ["EOSE", id]) {
  const sockets = [];
  const factory = () => {
    const socket = {
      readyState: 1,
      send(text) {
        const [kind, id, ...filters] = JSON.parse(text);
        if (kind === "AUTH") return reply(["OK", id.id, true]);
        if (kind !== "REQ") return;
        if (filters.length > 10)
          return reply(["CLOSED", id, "invalid: too many filters"]);
        const frame = filters.some((filter) => filter["#h"])
          ? answer(id)
          : ["EOSE", id];
        if (frame) reply(frame);
      },
      close() {
        this.readyState = 3;
      },
    };
    const reply = (frame) =>
      setTimeout(() => {
        if (socket.readyState === 1)
          socket.onmessage?.({ data: JSON.stringify(frame) });
      }, 40);
    setTimeout(
      () => socket.onmessage?.({ data: JSON.stringify(["AUTH", "c"]) }),
      20,
    );
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}
const options = (relay) => ({
  url: "wss://relay.test",
  key: generateSecretKey(),
  socketFactory: relay.factory,
  now: () => Date.now(),
});
async function run(name, channels, answer) {
  const relay = fakeRelay(answer);
  const result = runStrategy({
    ...options(relay),
    channels,
    strategy: parseStrategy(name),
  });
  await vi.runAllTimersAsync();
  return { ...(await result), sockets: relay.sockets.length };
}
const channels = Array.from({ length: 20 }, (_, i) => `channel-${i}`);

it("measures coverage for the app's subscriber and for raw batch shapes", async () => {
  vi.useFakeTimers();
  const one = await run("client:1", channels);
  const four = await run("client:4", channels);
  const packed = await run("filters:10", channels);
  const single = await run("multi-h:all", channels);
  // The app also sets up its profile and membership routes.
  expect([one.reqs, four.reqs, packed.reqs, single.reqs]).toEqual([
    22, 22, 2, 1,
  ]);
  for (const result of [one, four, packed, single])
    expect(result).toMatchObject({
      channels: 20,
      failed: 0,
      authMs: 60,
      canaryMs: expect.any(Number),
      sockets: 1,
    });
  // One round trip per outstanding slot: 22 serial, ceil(22 / 4) = 6, then 1.
  expect(one.coverageMs).toBe(22 * 40);
  expect(four.coverageMs).toBe(6 * 40);
  expect(packed.coverageMs).toBe(40);
  expect(single.reqMs).toEqual([40]);
});

it("reports relay refusals and an idle baseline canary", async () => {
  vi.useFakeTimers();
  const refused = await run("filters:11", channels);
  // Eleven channels in the refused REQ; the remaining nine fit under the cap.
  expect(refused).toMatchObject({
    reqs: 2,
    failed: 11,
    failures: { "invalid: too many filters": 1 },
  });
  const idle = await run("idle", channels);
  expect(idle).toMatchObject({ reqs: 0, failed: 0, canaryMs: 40 });
  expect(() => parseStrategy("client:0")).toThrow();
  expect(() => parseStrategy("batch:4")).toThrow();
});

it("finishes when the app's subscriber gives up on quota refusals without a frame", async () => {
  vi.useFakeTimers();
  // A cooldown over 60 s makes the subscriber stop its whole unsent queue locally.
  const refused = await run("client:1", channels, (id) => [
    "CLOSED",
    id,
    "rate-limited: quota exceeded; retry in 120s",
  ]);
  // Profiles, membership, then the one channel REQ that was refused.
  expect(refused).toMatchObject({ reqs: 3, failed: 20 });
  expect(refused.error).toBeUndefined();
  expect(refused.coverageMs).toBeUndefined();
});

it("reports timed-out runs and gives no coverage median unless every run finished", async () => {
  vi.useFakeTimers();
  let answered = 0;
  // The first run's channel REQs are never answered; later runs are.
  const relay = fakeRelay((id) => (answered++ < 2 ? null : ["EOSE", id]));
  const report = probe({
    ...options(relay),
    channels: channels.slice(0, 2),
    strategies: [parseStrategy("multi-h:1")],
    runs: 3,
    pauseMs: 0,
    timeoutMs: 1000,
  });
  await vi.runAllTimersAsync();
  const { summary, results } = await report;
  expect(results.map((result) => result.error)).toEqual([
    "timed out",
    undefined,
    undefined,
  ]);
  expect(summary[0]).toMatchObject({ runs: 3, incomplete: 1, failed: 2 });
  expect(summary[0].coverageMs).toBeUndefined();
});
