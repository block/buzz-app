import { describe, expect, it } from "vitest";
import {
  channelAccessCapability,
  channelAccessRequest,
  createChannelAccessReader,
  isBanned,
  parseChannelAccess,
} from "./channel-access";
import { readErrorKind } from "./errors";

const a = "00000000-0000-8000-8000-00000000000a";
const b = "00000000-0000-8000-8000-00000000000b";

describe("channel access answer", () => {
  it("is advertised by the relay's supported extensions", () => {
    expect(
      channelAccessCapability({
        supported_extensions: ["nip-cl", "buzz-channel-access"],
      }),
    ).toBe(true);
    expect(channelAccessCapability({ supported_extensions: ["nip-cl"] })).toBe(
      false,
    );
    expect(channelAccessCapability(undefined)).toBe(false);
  });

  it("asks about a bounded set of distinct channel ids", () => {
    expect(channelAccessRequest([a, b])).toEqual([
      { access: "channels", ids: [a, b] },
    ]);
    expect(() => channelAccessRequest([])).toThrow();
    expect(() => channelAccessRequest([a, a])).toThrow();
    expect(() => channelAccessRequest(["bad id"])).toThrow();
    expect(() =>
      channelAccessRequest(Array.from({ length: 101 }, (_, i) => `c${i}`)),
    ).toThrow();
  });

  it("reads one entry per readable channel and leaves the rest out", () => {
    const answer = parseChannelAccess(
      [{ id: a, read: true, post: false, joined: false, role: "guest" }],
      [a, b],
    );
    expect(answer.get(a)).toEqual({
      post: false,
      joined: false,
      role: "guest",
    });
    expect(answer.has(b)).toBe(false);
  });

  it("rejects an answer it cannot trust as a whole, never part of it", () => {
    for (const body of [
      {},
      [{ id: "other", read: true, post: true, joined: true, role: "member" }],
      [
        { id: a, read: true, post: true, joined: true, role: "member" },
        { id: a, read: true, post: true, joined: true, role: "member" },
      ],
      [{ id: a, read: false, post: false, joined: false, role: "member" }],
      [{ id: a, read: true, post: "yes", joined: true, role: "member" }],
      [{ id: a, read: true, post: true, joined: true, role: "bot" }],
      [{ id: a, read: true, post: true, joined: false, role: "guest" }],
      [
        {
          ...{ id: a, read: true, post: true, joined: true, role: "member" },
          timed_out_until: 1_900_000_000,
        },
      ],
      [
        {
          ...{ id: a, read: true, post: false, joined: true, role: "member" },
          timed_out_until: "soon",
        },
      ],
    ])
      expect(() => parseChannelAccess(body, [a, b])).toThrow();
  });

  it("carries a timeout's end, so the app knows when to ask again", () => {
    const answer = parseChannelAccess(
      [
        {
          ...{ id: a, read: true, post: false, joined: true, role: "member" },
          timed_out_until: 1_900_000_000,
        },
      ],
      [a],
    );
    expect(answer.get(a)).toEqual({
      post: false,
      joined: true,
      role: "member",
      until: 1_900_000_000,
    });
  });

  it("takes the relay's refusal of a banned viewer as a denial", async () => {
    const read = createChannelAccessReader(
      async () =>
        new Response(
          JSON.stringify({
            error: "blocked: you are banned from this community",
          }),
          { status: 403 },
        ),
    );
    const error = await read([a], new AbortController().signal).catch(
      (failure: unknown) => failure,
    );
    expect(isBanned(error)).toBe(true);
    expect(readErrorKind(error)).toBe("denied");
  });

  it("treats a failed request as couldn't check, never as denial", async () => {
    for (const status of [403, 500]) {
      const read = createChannelAccessReader(
        async () => new Response("{}", { status }),
      );
      const error = await read([a], new AbortController().signal).catch(
        (failure: unknown) => failure,
      );
      expect(readErrorKind(error)).toBe("unavailable");
    }
  });
});
