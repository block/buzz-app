// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { RelayEvent } from "../../features/relay/events";
import { createOutbox, type OutgoingEvent } from "../../features/relay/outbox";
import { keypair, signed } from "../../features/relay/testing";
import { ConversationTab } from "./ConversationTab";

// Exercise the real tab recovery owner and durable outbox without mounting the
// independent timelines/composers. Recovery must work with no editor mounted.
vi.mock("../../features/messages/ThreadPanel", () => ({
  ThreadPanel: () => <aside>Thread content</aside>,
}));
vi.mock("./ChannelBody", () => ({
  ChannelBody: () => <div>Conversation content</div>,
}));
vi.mock("../../features/messages/MessageComposer", () => ({
  MessageComposer: () => null,
}));
const owners: ReturnType<typeof createOutbox>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
});

it.each(["thread", "conversation"] as const)(
  "%s tabs recover failed edits outside the editor and only for their channel",
  async (kind) => {
    const viewer = keypair();
    const edit = (channel: string, content: string) =>
      signed(viewer, {
        kind: 40003,
        created_at: 1700000001,
        content,
        tags: [
          ["h", channel],
          ["e", "a".repeat(64)],
        ],
      });
    const retry = edit("beta", "Retry this correction");
    const discard = edit("beta", "Discard this correction");
    const unrelated = edit("alpha", "Other channel correction");
    let stored: readonly OutgoingEvent[] = [retry, discard, unrelated].map(
      (event) => ({
        event,
        signed: event,
        delivery: "failed",
        error: "Edit refused",
      }),
    );
    const publish = vi.fn(async (_event: RelayEvent) => {});
    const owner = createOutbox(
      viewer.pubkey,
      { kinds: [40003], sign: async (event) => signed(viewer, event), publish },
      {
        load: async () => stored,
        save: (next) => {
          stored = next;
        },
      },
    );
    owners.push(owner);
    await owner.outbox.ready();
    const channels = {
      status: "ready",
      channels: [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
      ],
    };
    // Only management consumes this session; the independent child views above
    // are stubbed, so the fixture supplies just its list and outbox boundary.
    const session = {
      outbox: owner.outbox,
      channels: { list: () => channels, subscribeList: () => () => {} },
    } as unknown as RelaySession;
    render(
      <ConversationTab
        tab={{
          id: "beta-tab",
          kind,
          channelId: "beta",
          messageId: "a".repeat(64),
        }}
        channel={{ id: "beta", name: "Beta" }}
        session={session}
        scope="recovery-test"
        openLink={() => false}
        canOpenLink={() => false}
        openThread={() => {}}
        close={() => {}}
      />,
    );
    const notices = screen.getAllByRole("status");
    expect(notices).toHaveLength(2);
    expect(screen.queryByText(unrelated.content)).not.toBeInTheDocument();
    const retryNotice = notices.find((notice) =>
      notice.textContent?.includes(retry.content),
    );
    assert.exists(retryNotice);
    fireEvent.click(
      within(retryNotice).getByRole("button", { name: "Retry message update" }),
    );
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0]?.[0]).toEqual(retry);
    await waitFor(() =>
      expect(screen.queryByText(retry.content)).not.toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Discard failed update" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("status")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(stored.map((item) => [item.event.id, item.delivery])).toEqual([
        [retry.id, "accepted"],
        [unrelated.id, "failed"],
      ]),
    );
    expect(publish).toHaveBeenCalledTimes(1);
  },
);
