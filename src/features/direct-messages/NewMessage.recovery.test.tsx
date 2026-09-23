// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRelaySession } from "../relay/session";
import { keypair, profile, roster, signed } from "../relay/testing";
import {
  PublishRejected,
  type OutboxStorage,
  type OutgoingEvent,
} from "../relay/outbox";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { NewMessage } from "./NewMessage";
import { OutboxStatus } from "../../bundled/channels/OutboxStatus";
import { createRelayProfiler } from "../relay/profiling";

const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const channel = "11111111-1111-4111-8111-111111111111";
const scope = `https://relay.example:${viewer.pubkey}`;
const owners: ReturnType<typeof createRelaySession>[] = [];
beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
});
function setup() {
  let records: readonly OutgoingEvent[] = [];
  const storage: OutboxStorage = {
    load: () => structuredClone(records),
    save: (next) => {
      records = structuredClone(next);
    },
  };
  const publish = vi.fn<
    (event: RelayEvent, signal: AbortSignal) => Promise<void>
  >(async () => {});
  const events = [
    profile(other, { name: "Avery" }),
    signed(relay, {
      kind: 39000,
      tags: [
        ["d", channel],
        ["t", "dm"],
      ],
      content: JSON.stringify({ name: "Avery", channel_type: "dm" }),
    }),
    roster(relay, channel, [viewer.pubkey, other.pubkey]),
  ];
  const query = async (filters: readonly ReadFilter[]) =>
    events.filter((event) =>
      filters.some(
        (filter) =>
          (!filter.kinds || filter.kinds.includes(event.kind)) &&
          (!filter.ids || filter.ids.includes(event.id)) &&
          (!filter.authors || filter.authors.includes(event.pubkey)) &&
          (!filter["#d"] ||
            event.tags.some(
              ([tag, value]) =>
                tag === "d" &&
                value !== undefined &&
                filter["#d"]?.includes(value),
            )),
      ),
    );
  const create = () => {
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        media: () => undefined,
        query,
        openDirectMessage: async () => channel,
        writer: {
          kinds: [9],
          sign: async (event) => signed(viewer, event),
          publish,
        },
      },
      { outboxStorage: storage },
    );
    owners.push(owner);
    return owner;
  };
  const onStarted = vi.fn();
  const mount = (owner: ReturnType<typeof create>) =>
    render(
      <NewMessage
        session={owner.session}
        scope={scope}
        onStarted={onStarted}
      />,
    );
  const user = userEvent.setup();
  const compose = async () => {
    await user.click(await screen.findByRole("option", { name: "Avery" }));
    await user.type(screen.getByRole("textbox"), "Durable first message");
  };
  return {
    storage,
    publish,
    create,
    mount,
    compose,
    user,
    onStarted,
    records: () => records,
  };
}
const send = () => screen.getByRole("button", { name: "Send message" });

it("recovers an uncertain first send after localStorage failure and session restart without a new event", async () => {
  const t = setup();
  t.publish.mockRejectedValueOnce(new Error("Receipt lost"));
  const first = t.create();
  const page = t.mount(first);
  await t.compose();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Quota exceeded");
  });
  await t.user.click(send());
  await screen.findByRole("alert");
  await waitFor(() =>
    expect(t.records().find((item) => item.recovery)?.delivery).toBe("unknown"),
  );
  const original = t.publish.mock.calls[0]?.[0];
  assert.exists(original);
  page.unmount();
  first.dispose();
  const second = t.create();
  t.mount(second);
  await waitFor(() => expect(send()).toBeEnabled());
  expect(screen.getByRole("textbox")).toHaveTextContent(
    "Durable first message",
  );
  expect(screen.getByRole("button", { name: "Remove Avery" })).toBeDisabled();
  await t.user.click(screen.getByRole("button", { name: "Retry send" }));
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.publish).toHaveBeenCalledTimes(2);
  expect(t.publish.mock.calls[1]?.[0]).toEqual(original);
  expect(t.records().some((item) => item.recovery)).toBe(false);
});

it("removing a failed operation in Diagnostics unlocks the preserved draft on reopening", async () => {
  const t = setup();
  t.publish.mockRejectedValueOnce(new PublishRejected("Not sent"));
  const owner = t.create();
  const outbox = owner.session.outbox;
  assert.exists(outbox);
  const page = t.mount(owner);
  await t.compose();
  await t.user.click(send());
  await screen.findByRole("alert");
  await waitFor(() => expect(outbox.snapshot()[0]?.delivery).toBe("failed"));
  page.unmount();
  const diagnostics = render(
    <OutboxStatus outbox={outbox} profiling={createRelayProfiler()} />,
  );
  await t.user.click(
    screen.getByRole("button", { name: "Remove from outbox" }),
  );
  await waitFor(() =>
    expect(t.records().some((item) => item.recovery)).toBe(false),
  );
  diagnostics.unmount();
  t.mount(owner);
  await waitFor(() => expect(send()).toBeEnabled());
  expect(screen.getByRole("textbox")).toHaveTextContent(
    "Durable first message",
  );
  expect(screen.getByRole("button", { name: "Remove Avery" })).toBeEnabled();
  await t.user.click(send());
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.publish).toHaveBeenCalledTimes(2);
});

it("never publishes if the durable recovery write fails", async () => {
  const t = setup();
  t.storage.save = async () => {
    throw new Error("Disk full");
  };
  const owner = t.create();
  t.mount(owner);
  await t.compose();
  await t.user.click(send());
  await screen.findByRole("alert");
  expect(t.publish).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox")).toHaveTextContent(
    "Durable first message",
  );
});
