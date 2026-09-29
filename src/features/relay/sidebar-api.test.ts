import { expect, it } from "vitest";
import {
  createSidebarApi,
  sidebarOperation,
  sidebarResponse,
  supportsSidebarApi,
} from "./sidebar-api";
const channel = "01234567-89ab-cdef-0123-456789abcdef";
const other = "11234567-89ab-cdef-0123-456789abcdef";
const id = "a".repeat(64);
const signal = () => new AbortController().signal;
const account = {
  retention_seconds: 2592000,
  cutoff_ms: -1000,
  imported_at_ms: null,
};
const row = () => ({
  channel_id: channel,
  name: "channel",
  channel_type: "stream",
  archived: false,
  hidden: false,
  unread: { status: "unknown" },
  attention: { status: "exact", value: 0 },
  latest_message_id: id,
  latest_message_at: 0,
  latest_message_complete: true,
  threads: { items: [], complete: false },
});
it("only produces exact purpose-bound URLs and bodies", () => {
  expect(sidebarOperation({ type: "sidebar", query: {} })).toEqual({
    path: "/buzz/v1/me/sidebar?limit=20",
    method: "GET",
  });
  const query = [{ target: { channel_id: channel }, message_ids: [id] }];
  const contexts = sidebarOperation({ type: "contexts", targets: query });
  expect(
    JSON.parse(
      new URL(contexts.path, "https://relay.test").searchParams.get(
        "targets",
      ) ?? "null",
    ),
  ).toEqual(query);
  const intent = {
    type: "mark_channel_read",
    channel_id: channel,
    message_id: id,
  };
  expect(sidebarOperation({ type: "write", intents: [intent] })).toEqual({
    path: "/buzz/v1/me/read-state",
    method: "POST",
    body: JSON.stringify({ intents: [intent] }),
  });
});
it.each([
  { type: "sidebar", query: { channel_ids: [] } },
  { type: "sidebar", query: { channel_ids: [channel, channel] } },
  { type: "sidebar", query: { channel_ids: [channel], cursor: channel } },
  { type: "sidebar", query: { channel_ids: Array(21).fill(channel) } },
  { type: "sidebar", query: { cursor: "../../events" } },
  { type: "sidebar", query: {}, path: "/events" },
  { type: "contexts", targets: [] },
  {
    type: "contexts",
    targets: [
      { target: { channel_id: channel }, message_ids: Array(101).fill(id) },
    ],
  },
  { type: "write", intents: [{ type: "complete_import" }] },
  {
    type: "write",
    intents: [
      {
        type: "mark_channel_read",
        channel_id: channel,
        message_id: id,
        actor: id,
      },
    ],
  },
])("rejects invalid or expanded operation %j", (value) =>
  expect(() => sidebarOperation(value)).toThrow(),
);
it("preserves uncertainty, epoch zero, and extensible response fields", async () => {
  const value = { account, channels: [row()], next_cursor: null, future: true };
  const api = createSidebarApi(async () => value);
  expect(await api.sidebar({}, signal())).toBe(value);
  expect((await api.sidebar({}, signal())).channels[0]?.unread).toEqual({
    status: "unknown",
  });
});
it.each([
  { ...row(), unread: { status: "unknown", value: 0 } },
  { ...row(), unread: { status: "at_least", value: 0 } },
  { ...row(), latest_message_at: null },
  { ...row(), threads: { items: [], complete: "yes" } },
])("rejects malformed row %j", async (r) => {
  await expect(
    createSidebarApi(async () => ({
      account,
      channels: [r],
      next_cursor: null,
    })).sidebar({}, signal()),
  ).rejects.toThrow();
});
it("rejects uncorrelated rows, cursors, selectors and write outcomes", async () => {
  let value: unknown = { account, channels: [row()], next_cursor: other };
  const api = createSidebarApi(async () => value);
  await expect(api.sidebar({}, signal())).rejects.toThrow();
  value = { account, channels: [row()], next_cursor: null };
  await expect(
    api.sidebar({ channel_ids: [other] }, signal()),
  ).rejects.toThrow();
  await expect(api.sidebar({ cursor: channel }, signal())).rejects.toThrow();
  value = {
    account,
    contexts: [
      {
        status: "available",
        through_timestamp: null,
        messages: [{ message_id: "b".repeat(64), status: "read" }],
      },
    ],
  };
  await expect(
    api.contexts(
      [{ target: { channel_id: channel }, message_ids: [id] }],
      signal(),
    ),
  ).rejects.toThrow();
  value = { outcomes: [], projection_status: "not_requested" };
  await expect(
    api.write(
      [{ type: "mark_channel_read", channel_id: channel, message_id: id }],
      signal(),
    ),
  ).rejects.toThrow();
});
it("retains ambiguous writes instead of inventing acknowledgement", async () => {
  const value = {
    outcomes: [{ status: "unknown", retryable: true }],
    projection_status: "not_requested",
  };
  const result = await createSidebarApi(async () => value).write(
    [{ type: "mark_channel_read", channel_id: channel, message_id: id }],
    signal(),
  );
  expect(result).toEqual(value.outcomes);
});
it("fences cancelled responses and bounds stream bytes", async () => {
  const cancel = new AbortController();
  const api = createSidebarApi(async () => {
    cancel.abort();
    return { account, channels: [], next_cursor: null };
  });
  await expect(api.sidebar({}, cancel.signal)).rejects.toThrow();
  await expect(
    sidebarResponse(new Response(`"${"a".repeat(1024 * 1024)}"`)),
  ).rejects.toThrow();
});
it("requires the complete advertised contract", () => {
  expect(
    supportsSidebarApi({
      version: 1,
      base_path: "/buzz/v1",
      max_channels: 20,
      max_intents: 100,
      max_contexts: 20,
      max_context_messages: 100,
    }),
  ).toBe(false);
});
