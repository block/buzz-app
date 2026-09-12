import { createHash } from "node:crypto";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { VerifiedEvent } from "nostr-tools";
import { connectSignedTransport } from "./transport";
import { keypair, signed } from "./testing";
import { isPresenceSnapshot } from "./presence-contract";

class Socket {
  readyState = 1;
  frames: { frame: unknown[]; at: number }[] = [];
  onmessage?: (event: { data: string }) => Promise<void>;
  send(text: string) {
    const frame = JSON.parse(text);
    this.frames.push({ frame, at: performance.now() });
    if (frame[0] === "REQ")
      queueMicrotask(() => {
        void this.receive(["EOSE", frame[1]]);
      });
    if (frame[0] === "EVENT")
      queueMicrotask(() => {
        void this.receive(["OK", frame[1].id, true]);
      });
  }
  close() {
    this.readyState = 3;
  }
  async receive(frame: unknown[]) {
    await this.onmessage?.({ data: JSON.stringify(frame) });
  }
  async auth() {
    await this.receive(["AUTH", "fixture"]);
    const event = this.frames.find(({ frame }) => frame[0] === "AUTH")
      ?.frame[1] as VerifiedEvent;
    await this.receive(["OK", event.id, true]);
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const author = (n: number) => n.toString(16).padStart(64, "0");
// Same first-call-anchored INCR/EXPIRE shape as the audited relay, not a rolling limiter.
function windowCounts(starts: number[], windowMs: number) {
  const counts: number[] = [];
  let end = -Infinity;
  for (const at of starts) {
    if (at >= end) {
      end = at + windowMs;
      counts.push(0);
    }
    counts[counts.length - 1] = (counts[counts.length - 1] ?? 0) + 1;
  }
  return counts;
}
function spacing(starts: number[], minimum: number) {
  for (let i = 1; i < starts.length; i++)
    expect(
      (starts[i] as number) - (starts[i - 1] as number),
    ).toBeGreaterThanOrEqual(minimum);
}
it("eight production signed transports share combined HTTP/REQ/EVENT budgets and correlated WS cooldown", async () => {
  vi.useFakeTimers();
  vi.spyOn(crypto.subtle, "digest").mockImplementation(
    async (_algorithm, data) =>
      Uint8Array.from(
        createHash("sha256")
          .update(new Uint8Array(data as ArrayBuffer))
          .digest(),
      ).buffer,
  );
  const sockets: Socket[] = [];
  vi.stubGlobal(
    "WebSocket",
    class extends Socket {
      constructor() {
        super();
        sockets.push(this);
      }
    },
  );
  const http: { at: number; presence: boolean }[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    http.push({
      at: performance.now(),
      presence: isPresenceSnapshot(JSON.parse(init.body as string)),
    });
    return Response.json([]);
  });
  const key = keypair();
  const transports = await Promise.all(
    Array.from({ length: 8 }, () =>
      connectSignedTransport(
        {
          getPublicKey: async () => key.pubkey,
          signEvent: async (event) => signed(key, event),
        },
        "https://combined-budget.test",
        key.pubkey,
      ),
    ),
  );
  const streams = transports.map((t) => {
    const stream = t.subscribe?.({
      receive() {},
      established() {},
      state() {},
      denied() {},
    });
    assert.exists(stream);
    assert.exists(stream.presence);
    return { ...stream, presence: stream.presence };
  });
  const pending: Promise<unknown>[] = [];
  const stop = new AbortController();
  const channels = Array.from({ length: 8 }, () => [] as string[]);
  try {
    for (const socket of sockets) await socket.auth();
    await vi.advanceTimersByTimeAsync(5000); // Drain all sixteen real global setups.
    const start = performance.now();
    for (let second = 0; second < 60; second++) {
      // Four new ordinary REQs race each second, using all eight callers.
      for (let i = 0; i < 4; i++) {
        const index = (second * 4 + i) % 8;
        const ids = channels[index];
        const stream = streams[index];
        assert.exists(ids);
        assert.exists(stream);
        ids.push(`c-${second}-${i}`);
        stream.update(ids);
      }
      for (const stream of streams)
        stream.presence.update([author(second + 1)]);
      // Saturate optional demand every second; the production gates (not the driver) must enforce 5s.
      // Eight ordinary HTTP callers every 4s saturate their separate 500ms clock.
      if (second % 4 === 0)
        for (const t of transports)
          pending.push(t.query([{ kinds: [9], limit: 1 }]));
      for (const t of transports)
        pending.push(
          t
            .query(
              [{ kinds: [20001], authors: [author(second + 1)], limit: 1 }],
              stop.signal,
            )
            .catch(() => {}),
        );
      for (const stream of streams)
        pending.push(
          stream.presence.publish("online", stop.signal).catch(() => {}),
        );
      await vi.advanceTimersByTimeAsync(1000);
    }
    const frames = sockets
      .flatMap((s) => s.frames)
      .filter((f) => f.at >= start && f.at < start + 60000)
      .sort((a, b) => a.at - b.at);
    const req = frames.filter(({ frame }) => frame[0] === "REQ");
    const ordinary = req
      .filter(
        ({ frame }) => (frame[2] as { kinds: number[] }).kinds[0] !== 20001,
      )
      .map((f) => f.at);
    const presence = req
      .filter(
        ({ frame }) => (frame[2] as { kinds: number[] }).kinds[0] === 20001,
      )
      .map((f) => f.at);
    const events = frames
      .filter(({ frame }) => frame[0] === "EVENT")
      .map((f) => f.at);
    const api = http.filter((f) => f.at < start + 60000);
    expect(ordinary).toHaveLength(240);
    expect(presence.length).toBeGreaterThanOrEqual(58);
    expect(events).toHaveLength(12);
    expect(api).toHaveLength(132);
    spacing(ordinary, 250);
    spacing(presence, 1000);
    spacing(events, 5000);
    spacing(
      api.filter((f) => !f.presence).map((f) => f.at),
      500,
    );
    spacing(
      api.filter((f) => f.presence).map((f) => f.at),
      5000,
    );
    expect(
      Math.max(
        ...windowCounts(
          api.map((f) => f.at),
          60000,
        ),
      ),
    ).toBe(132); // < API300
    const ws = frames
      .filter(({ frame }) => frame[0] === "REQ" || frame[0] === "EVENT")
      .map((f) => f.at);
    expect(Math.max(...windowCounts(ws, 5000))).toBeLessThanOrEqual(26); // < WS50, combined not separate per socket/kind.
    expect(Math.max(...windowCounts(events, 60000))).toBe(12); // < Messages60
    stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all(pending);
    // A correlated presence CLOSED pauses all streams, but not the independent API family.
    const source = sockets.find((s) =>
      s.frames.some(
        ({ frame }) =>
          frame[0] === "REQ" &&
          (frame[2] as { kinds: number[] }).kinds[0] === 20001,
      ),
    );
    assert.exists(source);
    const route = [...source.frames]
      .reverse()
      .find(
        ({ frame }) =>
          frame[0] === "REQ" &&
          (frame[2] as { kinds: number[] }).kinds[0] === 20001,
      );
    assert.exists(route);
    await source.receive([
      "CLOSED",
      route.frame[1],
      "rate-limited: quota exceeded; retry in 3s",
    ]);
    const before = sockets.reduce(
      (sum, s) =>
        sum +
        s.frames.filter(
          ({ frame }) => frame[0] === "REQ" || frame[0] === "EVENT",
        ).length,
      0,
    );
    streams.forEach((s, i) => {
      s.update([...(channels[i] ?? []), `paused-${i}`]);
    });
    const publication = streams
      .at(-1)
      ?.presence.publish("away", new AbortController().signal);
    await transports[0]?.query([{ kinds: [9], limit: 1 }]);
    await vi.advanceTimersByTimeAsync(3999);
    expect(
      sockets.reduce(
        (sum, s) =>
          sum +
          s.frames.filter(
            ({ frame }) => frame[0] === "REQ" || frame[0] === "EVENT",
          ).length,
        0,
      ),
    ).toBe(before);
    await vi.advanceTimersByTimeAsync(3001);
    await publication;
    expect(
      sockets.some((s) =>
        s.frames.some(
          ({ frame }) =>
            frame[0] === "REQ" &&
            (frame[2] as { "#h"?: string[] })["#h"]?.[0]?.startsWith("paused-"),
        ),
      ),
    ).toBe(true);
  } finally {
    for (const stream of streams) stream.dispose();
  }
}, 15000);
