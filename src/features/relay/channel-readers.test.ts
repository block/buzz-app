import { describe, expect, it, vi } from "vitest";
import {
  channelReadersCapability,
  channelReadersRequest,
  createChannelReadersReader,
  parseChannelReaders,
} from "./channel-readers";
import { ReadError } from "./errors";

const channel = "00000000-0000-8000-8000-00000000000a";
const a = "a".repeat(64);
const b = "b".repeat(64);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("channel readers answer", () => {
  it("is advertised by the relay's supported extensions", () => {
    expect(
      channelReadersCapability({
        supported_extensions: ["buzz-channel-access", "buzz-channel-readers"],
      }),
    ).toBe(true);
    expect(
      channelReadersCapability({
        supported_extensions: ["buzz-channel-access"],
      }),
    ).toBe(false);
    expect(channelReadersCapability(undefined)).toBe(false);
  });

  it("asks about one channel and a bounded set of distinct people", () => {
    expect(channelReadersRequest(channel, [a, b])).toEqual([
      { access: "readers", channel, pubkeys: [a, b] },
    ]);
    expect(() => channelReadersRequest(channel, [])).toThrow();
    expect(() => channelReadersRequest(channel, [a, a])).toThrow();
    expect(() => channelReadersRequest(channel, ["A".repeat(64)])).toThrow();
    expect(() => channelReadersRequest("bad id", [a])).toThrow();
  });

  it("reads exactly one entry per person, in order, and nothing partial", () => {
    expect(
      parseChannelReaders(
        [
          { pubkey: a, read: true },
          { pubkey: b, read: false },
        ],
        [a, b],
      ),
    ).toEqual(
      new Map([
        [a, true],
        [b, false],
      ]),
    );
    for (const body of [
      [{ pubkey: a, read: true }],
      [
        { pubkey: b, read: true },
        { pubkey: a, read: false },
      ],
      [
        { pubkey: a, read: "yes" },
        { pubkey: b, read: false },
      ],
      { error: "not-allowed" },
    ])
      expect(() => parseChannelReaders(body, [a, b])).toThrow(ReadError);
  });

  it("fails on a refusal or an error, never answering false for everyone", async () => {
    for (const [status, kind] of [
      [403, "denied"],
      [503, "unavailable"],
    ] as const) {
      const read = createChannelReadersReader(async () =>
        json(
          { error: "not-allowed: the signer cannot read this channel" },
          status,
        ),
      );
      const failure = await read(channel, [a], new AbortController().signal)
        .then(() => undefined)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ReadError);
      expect((failure as ReadError).kind).toBe(kind);
    }
  });

  it("asks in pages of the relay's limit and joins the answers", async () => {
    const people = Array.from({ length: 150 }, (_, at) =>
      at.toString(16).padStart(64, "0"),
    );
    const request = vi.fn(async (body: unknown) => {
      const [{ pubkeys }] = body as [{ pubkeys: string[] }];
      return json(pubkeys.map((pubkey) => ({ pubkey, read: true })));
    });
    const answer = await createChannelReadersReader(request)(
      channel,
      people,
      new AbortController().signal,
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(answer.size).toBe(150);
    expect(
      await createChannelReadersReader(request)(
        channel,
        [],
        new AbortController().signal,
      ),
    ).toEqual(new Map());
  });
});
