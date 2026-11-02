import { invoke } from "@tauri-apps/api/core";
import { eventDto, type ReadFilter, type RelayEvent } from "./events";
import type { ReadTransport } from "./transport";
import {
  parseThreadRecord,
  threadRecordCoordinate,
  threadNavigationTags,
  type ThreadNavigationHost,
  type ThreadRecord,
} from "../channel-navigation/recent-threads";

/** Same purpose-bound self-encryption/signing boundary as sidebar preferences. */
export function nativeThreadNavigation(
  transport: ReadTransport,
): ThreadNavigationHost {
  async function decode(events: readonly RelayEvent[], signal: AbortSignal) {
    const result: ThreadRecord[] = [];
    for (let i = 0; i < events.length; i += 5) {
      signal.throwIfAborted();
      const batch = events.slice(i, i + 5).map(eventDto);
      const decoded = await invoke<Record<string, unknown>>(
        "relay_decode_sidebar",
        { events: batch },
      );
      signal.throwIfAborted();
      for (const event of batch) {
        const coordinate = event.tags.find(([tag]) => tag === "d")?.[1];
        const record = parseThreadRecord(
          coordinate ? decoded[coordinate] : undefined,
        );
        if (
          event.pubkey !== transport.viewer ||
          event.kind !== 30078 ||
          coordinate !== (await threadRecordCoordinate(record)) ||
          JSON.stringify(event.tags) !==
            JSON.stringify([
              ["d", coordinate],
              ["t", threadNavigationTags[record.type]],
            ])
        )
          throw new Error("Invalid thread navigation binding");
        result.push(record);
      }
    }
    return result;
  }
  async function read(filters: readonly ReadFilter[], signal: AbortSignal) {
    const events = await transport.query(filters, signal);
    signal.throwIfAborted();
    return { events, records: await decode(events, signal) };
  }
  return {
    async read(signal) {
      const result = await read(
        [
          {
            kinds: [30078],
            authors: [transport.viewer],
            "#t": [threadNavigationTags.visit],
            limit: 200,
            consistency: "strong",
          },
          {
            kinds: [30078],
            authors: [transport.viewer],
            "#t": [threadNavigationTags.pin],
            limit: 1000,
            consistency: "strong",
          },
        ],
        signal,
      );
      if (
        result.records.filter((record) => record.type === "pin").length >= 1000
      )
        throw new Error(
          "Thread pin history reached its read limit; no partial list will be used",
        );
      return result.records;
    },
    async write(input, signal) {
      parseThreadRecord(input);
      const coordinate = await threadRecordCoordinate(input);
      const filter: ReadFilter = {
        kinds: [30078],
        authors: [transport.viewer],
        "#d": [coordinate],
        limit: 1,
        consistency: "strong",
      };
      const current = await read([filter], signal);
      const old = current.records[0];
      const record = { ...input, at: Math.max(input.at, (old?.at ?? 0) + 1) };
      const signed = eventDto(
        await invoke("relay_sign_sidebar", {
          coordinate,
          payload: record,
          createdAt: Math.max(
            Math.floor(Date.now() / 1000),
            (current.events[0]?.created_at ?? 0) + 1,
          ),
        }),
      );
      signal.throwIfAborted();
      if (!transport.writer)
        throw new Error("Native relay writer is unavailable");
      await transport.writer.publish(signed, signal);
      const confirmed = (await read([filter], signal)).records[0];
      if (
        !confirmed ||
        confirmed.type !== record.type ||
        confirmed.channelId !== record.channelId ||
        confirmed.rootId !== record.rootId ||
        confirmed.at !== record.at ||
        confirmed.title !== record.title ||
        (confirmed.type === "pin" &&
          (record.type !== "pin" || confirmed.pinned !== record.pinned))
      )
        throw new Error(
          "Thread navigation changed on another device. Try again.",
        );
      return confirmed;
    },
  };
}
