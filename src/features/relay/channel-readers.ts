// The relay's answer to "which of these people can read this channel"
// (`buzz-channel-readers`): judged by the check a task's assignees meet, and
// asked only about a channel the viewer can read. It is a snapshot; the relay
// still checks every save.
import { ReadError } from "./errors.ts";

/** Relay NIP-11 `supported_extensions` entry for the readers answer. */
export const CHANNEL_READERS_EXTENSION = "buzz-channel-readers";
/** Most people one request may name. */
export const CHANNEL_READERS_LIMIT = 100;

/** Who of the people asked about can read the channel: one entry each. */
export type ChannelReaders = ReadonlyMap<string, boolean>;

/** Throws when there is no complete answer: the viewer may not ask, or the
 * relay couldn't say. Never a partial answer. */
export type ChannelReadersReader = (
  channel: string,
  pubkeys: readonly string[],
  signal: AbortSignal,
) => Promise<ChannelReaders>;

const pubkey = /^[0-9a-f]{64}$/;
const channelId = /^[a-zA-Z0-9_-]{1,128}$/;

export function channelReadersCapability(info: unknown): boolean {
  const extensions =
    typeof info === "object" && info !== null
      ? (info as { supported_extensions?: unknown }).supported_extensions
      : undefined;
  return (
    Array.isArray(extensions) && extensions.includes(CHANNEL_READERS_EXTENSION)
  );
}

export function channelReadersRequest(
  channel: string,
  pubkeys: readonly string[],
) {
  if (
    !channelId.test(channel) ||
    pubkeys.length < 1 ||
    pubkeys.length > CHANNEL_READERS_LIMIT ||
    new Set(pubkeys).size !== pubkeys.length ||
    pubkeys.some((key) => !pubkey.test(key))
  )
    throw new Error("Invalid channel readers request");
  return [{ access: "readers", channel, pubkeys: [...pubkeys] }];
}

/** Strict: exactly one entry per person asked about, in order. */
export function parseChannelReaders(
  body: unknown,
  pubkeys: readonly string[],
): ChannelReaders {
  if (
    !Array.isArray(body) ||
    body.length !== pubkeys.length ||
    body.some(
      (entry, at) =>
        typeof entry !== "object" ||
        entry === null ||
        (entry as { pubkey?: unknown }).pubkey !== pubkeys[at] ||
        typeof (entry as { read?: unknown }).read !== "boolean",
    )
  )
    throw new ReadError("invalid-response", "Invalid channel readers answer");
  return new Map(
    (body as { pubkey: string; read: boolean }[]).map(
      (entry) => [entry.pubkey, entry.read] as const,
    ),
  );
}

/** Asks in pages of the relay's limit; any page that fails fails the whole
 * answer. A refusal (403) is `denied`; anything else is `unavailable`. */
export function createChannelReadersReader(
  request: (body: unknown, signal: AbortSignal) => Promise<Response>,
): ChannelReadersReader {
  const page = async (
    channel: string,
    pubkeys: readonly string[],
    signal: AbortSignal,
  ) => {
    const response = await request(
      channelReadersRequest(channel, pubkeys),
      signal,
    );
    signal.throwIfAborted();
    if (!response.ok)
      throw new ReadError(
        response.status === 403 ? "denied" : "unavailable",
        `Channel readers check failed (${response.status})`,
        response.status,
      );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ReadError("invalid-response", "Invalid channel readers answer");
    }
    return parseChannelReaders(body, pubkeys);
  };
  return async (channel, pubkeys, signal) => {
    const wanted = [...new Set(pubkeys)];
    const pages: Promise<ChannelReaders>[] = [];
    for (let at = 0; at < wanted.length; at += CHANNEL_READERS_LIMIT)
      pages.push(
        page(channel, wanted.slice(at, at + CHANNEL_READERS_LIMIT), signal),
      );
    const answer = new Map<string, boolean>();
    for (const part of await Promise.all(pages))
      for (const [key, read] of part) answer.set(key, read);
    return answer;
  };
}
