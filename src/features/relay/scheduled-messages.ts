import type { EventTemplate } from "nostr-tools";
import { createEventVerifier, type RelayEvent } from "./events";
import { parseEvents } from "./transport";
import type { UploadedAttachment } from "./attachments";
import type { MentionPicks } from "./messages";

export type ScheduledInput = Readonly<{
  destination: Readonly<{
    channelId: string;
    name: string;
    threadRootId?: string;
  }>;
  content: string;
  sendAt: number;
  mentions?: readonly string[];
  attachments?: readonly UploadedAttachment[];
  parentId?: string;
  references?: readonly string[];
  picks?: MentionPicks;
  mediaTargetUrl?: string;
}>;
export type ScheduledMessage = Readonly<{
  id: string;
  revision: string;
  destination: ScheduledInput["destination"];
  content: string;
  sendAt: number;
  status: "scheduled" | "sent" | "failed";
  error?: string;
}>;
/** Native/broker-owned signing and one authenticated, fixed queue route. */
export interface ScheduledHost {
  sign(template: EventTemplate, signal: AbortSignal): Promise<RelayEvent>;
  request(body: unknown, signal: AbortSignal): Promise<Response>;
}
export type ScheduledMessages = ReturnType<typeof createScheduledMessages>;
type Template = Pick<EventTemplate, "kind" | "content" | "tags">;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const schedulingErrors: Readonly<Partial<Record<number, string>>> = {
  400: "The relay rejected this schedule. Check the message and send time.",
  401: "Sign in to this community again before scheduling.",
  403: "You no longer have permission to schedule messages here.",
  404: "This community does not support scheduled delivery right now.",
  409: "This message changed or the queue is full. Refresh before trying again.",
  429: "The relay is limiting scheduling requests. Try again shortly.",
};

/** A session owns authorization/lifetime; the relay owns persistence and clocks. */
export function createScheduledMessages(
  host: ScheduledHost,
  options: {
    viewer: string;
    signal: AbortSignal;
    prepare(input: ScheduledInput): Template;
    name(channelId: string): string;
  },
) {
  const events = new Map<string, { event: RelayEvent; revision: string }>();
  const pending = new Map<string, { id: string; event: RelayEvent }>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  function signal(extra?: AbortSignal) {
    const owned = AbortSignal.any([
      options.signal,
      AbortSignal.timeout(15_000),
      ...(extra ? [extra] : []),
    ]);
    owned.throwIfAborted();
    return owned;
  }
  async function request(body: unknown, extra?: AbortSignal) {
    const live = signal(extra);
    const response = await host.request(body, live);
    live.throwIfAborted();
    if (!response.ok)
      throw new Error(
        schedulingErrors[response.status] ??
          "Could not reach scheduled delivery. Refresh to check whether the change was saved.",
      );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Scheduled delivery returned no response.");
    const decoder = new TextDecoder();
    let text = "",
      bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 16 * 1024 * 1024)
          throw new Error("Scheduled response is too large.");
        text += decoder.decode(part.value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    live.throwIfAborted();
    return JSON.parse(text + decoder.decode()) as unknown;
  }
  async function signed(sendAt: number, draft: Template) {
    const now = Date.now();
    if (
      !Number.isFinite(sendAt) ||
      sendAt <= now ||
      sendAt > now + 120 * 86_400_000
    )
      throw new Error("Choose a future time within 120 days.");
    const template = { ...draft, created_at: Math.floor(sendAt / 1000) };
    const live = signal();
    const event = await host.sign(template, live);
    live.throwIfAborted();
    if (
      event.pubkey !== options.viewer ||
      event.kind !== 9 ||
      event.created_at !== template.created_at ||
      event.content !== template.content ||
      JSON.stringify(event.tags) !== JSON.stringify(template.tags)
    )
      throw new Error("The signed message did not match the approved draft.");
    await parseEvents([event], createEventVerifier(), live);
    return event;
  }
  function current(id: string, revision: string) {
    const row = events.get(id);
    if (!row || row.revision !== revision)
      throw new Error("Refresh before changing this message.");
    return row.event;
  }
  return Object.freeze({
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async list(extra: AbortSignal): Promise<readonly ScheduledMessage[]> {
      const raw = (await request({ action: "list" }, extra)) as {
        messages?: unknown;
      };
      if (!Array.isArray(raw.messages) || raw.messages.length > 356)
        throw new Error("Invalid scheduled-message list.");
      await parseEvents(
        raw.messages.map((row) => row.event),
        createEventVerifier(),
        signal(extra),
      );
      const next = new Map<string, { event: RelayEvent; revision: string }>();
      const rows = raw.messages.map((row): ScheduledMessage => {
        const event = row.event as RelayEvent;
        if (
          !uuid.test(row.id) ||
          !Number.isSafeInteger(row.revision) ||
          row.revision < 1 ||
          !event ||
          event.pubkey !== options.viewer ||
          event.kind !== 9 ||
          typeof event.content !== "string" ||
          !Array.isArray(event.tags) ||
          !Number.isSafeInteger(row.send_at) ||
          !["scheduled", "sent", "failed"].includes(row.status) ||
          next.has(row.id)
        )
          throw new Error("Invalid scheduled-message row.");
        const channelId = event.tags.find(([name]) => name === "h")?.[1];
        if (!channelId || !uuid.test(channelId))
          throw new Error("Invalid scheduled conversation.");
        const root =
          event.tags.find(
            ([name, , , marker]) => name === "e" && marker === "root",
          )?.[1] ??
          event.tags.find(
            ([name, , , marker]) => name === "e" && marker === "reply",
          )?.[1];
        next.set(row.id, { event, revision: String(row.revision) });
        return {
          id: row.id,
          revision: String(row.revision),
          destination: {
            channelId,
            name: options.name(channelId),
            ...(root ? { threadRootId: root } : {}),
          },
          content: event.content,
          sendAt: row.send_at * 1000,
          status: row.status,
          ...(typeof row.error === "string" ? { error: row.error } : {}),
        };
      });
      events.clear();
      for (const [id, row] of next) events.set(id, row);
      return rows;
    },
    async create(input: ScheduledInput) {
      const template = options.prepare(input);
      const key = JSON.stringify([template, Math.floor(input.sendAt / 1000)]);
      let operation = pending.get(key);
      if (!operation) {
        operation = {
          id: crypto.randomUUID(),
          event: await signed(input.sendAt, template),
        };
        pending.set(key, operation);
      }
      await request({ action: "create", ...operation });
      pending.delete(key);
      changed();
    },
    async reschedule(id: string, revision: string, sendAt: number) {
      const previous = current(id, revision);
      const event = await signed(sendAt, {
        kind: previous.kind,
        content: previous.content,
        tags: previous.tags.map((t) => [...t]),
      });
      await request({
        action: "update",
        id,
        revision: Number(revision),
        event,
      });
      changed();
    },
    async cancel(id: string, revision: string) {
      current(id, revision);
      await request({ action: "cancel", id, revision: Number(revision) });
      changed();
    },
  });
}
