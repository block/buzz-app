import { vi } from "vitest";
import type {
  SidebarApi,
  SidebarPage,
  ChannelReadSummary,
  MessageReadState,
  ReadTarget,
} from "./sidebar-api";
import type { SidebarJournal, SidebarStorage } from "./sidebar-journal";

export const sidebarAccount = {
  retention_seconds: 2592000,
  cutoff_ms: 0,
};
export const sidebarRow = (
  channel_id: string,
  patch: Partial<ChannelReadSummary> = {},
): ChannelReadSummary => ({
  channel_id,
  name: channel_id,
  channel_type: "stream",
  archived: false,
  hidden: false,
  unread: { status: "exact", value: 0 },
  attention: { status: "exact", value: 0 },
  latest_message_id: null,
  latest_message_at: null,
  latest_message_complete: true,
  threads: { items: [], complete: true },
  ...patch,
});
/** Explicit server responses, not a second client-side counting implementation. */
export function sidebarFixture() {
  let journal: SidebarJournal = { pending: [], manual: [] };
  const rows = new Map<string, ChannelReadSummary>();
  const messages = new Map<string, MessageReadState>();
  const frontiers = new Map<string, number>();
  const key = (target: ReadTarget) =>
    `${target.channel_id}:${target.root_id ?? ""}`;
  const api = {
    eligibleKinds: [9, 40002, 45001, 45003],
    sidebar: vi.fn<SidebarApi["sidebar"]>(
      async (query): Promise<SidebarPage> => ({
        account: sidebarAccount,
        channels: [...rows.values()].filter(
          (r) =>
            !("channel_ids" in query) ||
            query.channel_ids.includes(r.channel_id),
        ),
        next_cursor: null,
      }),
    ),
    contexts: vi.fn<SidebarApi["contexts"]>(async (queries) => ({
      account: sidebarAccount,
      contexts: queries.map((q) => ({
        status: "available" as const,
        through_timestamp: frontiers.get(key(q.target)) ?? null,
        messages: q.message_ids.map(
          (id) =>
            messages.get(id) ?? { message_id: id, status: "unknown" as const },
        ),
      })),
    })),
    write: vi.fn<SidebarApi["write"]>(async (intents) =>
      intents.map(() => ({ status: "applied" })),
    ),
  };
  const storage: SidebarStorage = {
    async update(change) {
      journal = structuredClone(change(journal));
      return journal;
    },
    close() {},
  };
  return { api, storage, rows, messages, frontiers, journal: () => journal };
}

export function deferredSidebar<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
