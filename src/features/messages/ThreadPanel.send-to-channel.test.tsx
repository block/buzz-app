// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { keypair, message, metadata, roster, signed } from "../relay/testing";
import type { RelayEvent } from "../relay/events";
import { ThreadPanel } from "./ThreadPanel";
import type { ComposerInputElement } from "./composer-dom";
import { composerDOMFixture } from "./composer-testing";

composerDOMFixture();

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

it("real thread composer also sends a reply to the channel once the relay accepts it", async () => {
  const viewer = keypair(),
    relay = keypair(),
    other = keypair();
  const root = message(other, "channel", "Root message", 10);
  let accept = () => {};
  const accepted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const publish = vi.fn(async (event: RelayEvent) => {
    if (!event.tags.some(([name]) => name === "buzz:copy-of")) await accepted;
  });
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://copy.test",
      media: () => undefined,
      query: async (filters) =>
        filters.flatMap((filter) => {
          if (filter.kinds?.includes(39002))
            return [roster(relay, "channel", [viewer.pubkey, other.pubkey])];
          if (filter.kinds?.includes(39000))
            return [metadata(relay, "channel", "General")];
          if (filter.ids?.includes(root.id)) return [root];
          return [];
        }),
      writer: {
        kinds: [9, 40003],
        sign: async (template) => signed(viewer, template),
        publish,
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  try {
    await owner.session.read([
      { kinds: [39002], "#d": ["channel"], limit: 1 },
      { kinds: [39000], "#d": ["channel"], limit: 1 },
    ]);
    render(
      <ThreadPanel
        session={owner.session}
        scope="send-to-channel"
        channelName="General"
        channelId="channel"
        messageId={root.id}
        close={() => {}}
        onOpenLink={() => false}
      />,
      { reactStrictMode: true },
    );
    const box = await screen.findByRole("checkbox", {
      name: "Also send to #General",
    });
    await screen.findByText("Root message");
    fireEvent.click(box);
    expect(box).toBeChecked();
    const input = screen.getByRole<ComposerInputElement>("textbox", {
      name: "Reply to thread",
    });
    act(() => {
      input.value = "Shipping today";
      input.setSelectionRange(14, 14);
    });
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const reply = publish.mock.calls[0]?.[0];
    expect(reply?.tags).toContainEqual(["e", root.id, "", "reply"]);
    expect(box).not.toBeChecked();
    // The reply shows in the thread while the relay holds it; no copy yet.
    await screen.findByText("Shipping today");
    expect(publish).toHaveBeenCalledOnce();
    await act(async () => accept());
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    const copy = publish.mock.calls[1]?.[0];
    expect(copy?.content).toBe("Shipping today");
    expect(copy?.tags).toEqual(
      expect.arrayContaining([
        ["h", "channel"],
        ["buzz:sent-from-thread", root.id, "Root message"],
        ["buzz:copy-of", reply?.id],
      ]),
    );
    expect(copy?.tags.some(([name]) => name === "e")).toBe(false);
    // Saving an edit is not a send, so the option leaves while one is open.
    fireEvent.keyDown(input, { key: "ArrowUp", metaKey: true });
    expect(input).toHaveAccessibleName("Edit message");
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
    expect(
      await screen.findByRole("checkbox", { name: "Also send to #General" }),
    ).not.toBeChecked();
  } finally {
    accept();
    owner.dispose();
  }
});
