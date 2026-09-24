// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import {
  bounds,
  keypair,
  message,
  metadata,
  roster,
  signed,
} from "../relay/testing";
import { ThreadPanel } from "./ThreadPanel";
import type { ComposerInputElement } from "./composer-dom";

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

it("real ThreadPanel edits its own reply and recovers emoji preparation without losing text", async () => {
  const viewer = keypair(),
    relay = keypair(),
    other = keypair();
  const root = message(other, "channel", "Root message", 10);
  const reply = message(viewer, "channel", "Own reply", 11, [
    ["e", root.id, "", "reply"],
  ]);
  const events = [root, reply];
  let emojiAvailable = false;
  const publish = vi.fn(async () => {});
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://edit.test",
      media: () => undefined,
      query: async (filters) =>
        filters.flatMap((filter) => {
          if (filter.kinds?.includes(30030)) {
            if (!emojiAvailable) throw new Error("Emoji unavailable");
            return [];
          }
          if (filter.kinds?.includes(39002))
            return [roster(relay, "channel", [viewer.pubkey, other.pubkey])];
          if (filter.kinds?.includes(39000))
            return [metadata(relay, "channel", "General")];
          if (filter.ids)
            return events.filter((event) => filter.ids?.includes(event.id));
          if (filter.kinds?.includes(9))
            return [
              ...events,
              bounds(relay, "channel", "head", {
                has_more: false,
                next_cursor: null,
              }),
            ];
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
        scope="thread-edit"
        channelName="General"
        channelId="channel"
        messageId={root.id}
        close={() => {}}
        onOpenLink={() => false}
      />,
      { reactStrictMode: true },
    );
    const input = await screen.findByRole<ComposerInputElement>("textbox", {
      name: "Reply to thread",
    });
    // Loaded reply is the barrier: neither root-only state nor a channel window
    // can satisfy this edit target. Removing ThreadPanel's editMessages fails here.
    await screen.findByText("Own reply");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAccessibleName("Edit message");
    expect(input).toHaveValue("Own reply");
    await waitFor(() =>
      expect(owner.session.emoji.snapshot().status).toBe("error"),
    );
    act(() => {
      input.value = "Revised :party:";
      input.setSelectionRange(15, 15);
    });
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: "Enter" });
    const form = within(screen.getByRole("form", { name: "Edit message" }));
    expect(form.getByRole("alert")).toHaveTextContent(
      "Community emoji unavailable",
    );
    expect(publish).not.toHaveBeenCalled();
    emojiAvailable = true;
    fireEvent.click(
      screen.getByRole("button", { name: "Retry message preparation" }),
    );
    await waitFor(() =>
      expect(form.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(input).toHaveValue("Revised :party:");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input).toHaveAccessibleName("Reply to thread"));
    expect(publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: 40003,
        content: "Revised :party:",
        tags: [
          ["h", "channel"],
          ["e", reply.id],
          ["client-id", expect.any(String)],
        ],
      }),
      expect.anything(),
    );
    expect(input).toHaveValue("");
  } finally {
    cleanup();
    owner.dispose();
  }
});
