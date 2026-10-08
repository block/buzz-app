// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useReading } from "../messages/use-reading";
import type { RelaySession } from "../relay/session";
import type { ReadingHandle } from "../relay/unread";
import { flush, message, roster } from "../relay/testing";
import { cleanups, setup } from "./messages-testing";

afterEach(async () => {
  cleanup();
  for (const stop of cleanups.splice(0)) await stop();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
/**
 * The real reading hook over a focused, fully visible message list, against
 * the real session. Leases are recorded so tests can wait for their disposal.
 */
function mountList(
  h: Awaited<ReturnType<typeof setup>>,
  ids: readonly string[],
) {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const list = document.createElement("div");
  list.tabIndex = 0;
  document.body.append(list);
  list.focus();
  vi.spyOn(list, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 500, 500),
  ] as unknown as DOMRectList);
  vi.spyOn(list, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 500),
  );
  const rows = ids.map((id, index) => {
    const item = document.createElement("div");
    item.dataset.messageId = id;
    list.append(item);
    return vi
      .spyOn(item, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 100 + index * 100, 400, 100));
  });
  const real = h.owner.session.unread;
  const leases: { disposed: boolean }[] = [];
  const unread = {
    ...real,
    reading(channelId: string): ReadingHandle {
      const lease = real.reading(channelId);
      const record = { disposed: false };
      leases.push(record);
      return {
        ...lease,
        dispose() {
          record.disposed = true;
          lease.dispose();
        },
      };
    },
  };
  renderHook(useReading, {
    initialProps: {
      session: { unread } as unknown as RelaySession,
      channelId: "01234567-89ab-cdef-0123-456789abcdef",
      scroller: { current: list },
      settled: { current: true },
    },
  });
  /** Moves a row out of the viewport, as a user scroll does. */
  const scrollAway = (index: number) => {
    rows[index]?.mockReturnValue(new DOMRect(0, 600, 400, 100));
    list.dispatchEvent(new Event("scroll"));
  };
  const scrollIntoView = (index: number) => {
    rows[index]?.mockReturnValue(new DOMRect(0, 100 + index * 100, 400, 100));
    list.dispatchEvent(new Event("scroll"));
  };
  return { leases, scrollAway, scrollIntoView };
}
/** Holds delivery at its permission probe, as a slow presentation would. */
function holdPresentation(h: Awaited<ReturnType<typeof setup>>) {
  let present: (() => void) | undefined;
  h.permission.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        present = () => resolve("granted");
      }),
  );
  return {
    held: () => present !== undefined,
    present: () => present?.(),
  };
}
it.each(["in view", "window blur", "scroll away", "access loss"] as const)(
  "Notify while viewing: after the list's own dwell read, the alert follows the view (%s)",
  async (state) => {
    const h = await setup();
    h.notifications.updatePreferences({ notifyWhileViewing: true });
    const row = h.make("read before presentation");
    const delivery = holdPresentation(h);
    try {
      h.emit([row], "live");
      await vi.waitFor(() => expect(delivery.held()).toBe(true));
      // Keep an independent status consumer mounted so cancellation cannot
      // discard the very relay answer this regression needs to observe.
      cleanups.push(
        h.owner.session.unread.subscribe(
          {
            kind: "message",
            channelId: "01234567-89ab-cdef-0123-456789abcdef",
            messageId: row.id,
          },
          () => {},
        ),
      );
      const list = mountList(h, [row.id]);
      const attention = () =>
        h.owner.session.unread.attention(
          "01234567-89ab-cdef-0123-456789abcdef",
          row.id,
        );
      // Dwell completes, and its write lease is released after the read.
      await vi.waitFor(() => expect(list.leases[0]?.disposed).toBe(true));
      // Force and observe a real context read answer before releasing delivery.
      await h.owner.session.unread.refresh();
      expect(attention()).toMatchObject({
        status: "ineligible",
        relayRead: true,
        unread: false,
        viewing: true,
      });
      if (state === "access loss")
        h.emit([
          roster(
            h.relay,
            "01234567-89ab-cdef-0123-456789abcdef",
            [],
            Math.floor(Date.now() / 1000) + 1,
          ),
        ]);
      if (state === "window blur") window.dispatchEvent(new Event("blur"));
      if (state === "scroll away") list.scrollAway(0);
      delivery.present();
      await flush();
      expect(h.show).toHaveBeenCalledTimes(state === "in view" ? 1 : 0);
    } finally {
      delivery.present();
    }
  },
);
it("Notify while viewing: a row read and scrolled away stays quiet while a later row's write is pending", async () => {
  // Hold the second dwell's journal admission after the first read settles.
  let release: (() => void) | undefined;
  let armed = false;
  const gate = () =>
    !armed
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          release = resolve;
        });
  const h = await setup(gate);
  h.notifications.updatePreferences({ notifyWhileViewing: true });
  const alerted = h.make("alerted");
  // A plain channel message, so only the first row raises an alert.
  const quiet = message(
    h.peer,
    "01234567-89ab-cdef-0123-456789abcdef",
    "quiet",
    Math.floor(Date.now() / 1000),
  );
  const delivery = holdPresentation(h);
  try {
    h.emit([alerted, quiet], "live");
    await vi.waitFor(() => expect(delivery.held()).toBe(true));
    const list = mountList(h, [alerted.id, quiet.id]);
    list.scrollAway(1);
    const attention = (id: string) =>
      h.owner.session.unread.attention(
        "01234567-89ab-cdef-0123-456789abcdef",
        id,
      );
    // The journal batches visible IDs. Earn separate dwells so the second
    // admission is held without relying on per-message storage writes.
    await vi.waitFor(() => expect(attention(alerted.id).unread).toBe(false));
    await vi.waitFor(() =>
      expect(list.leases.slice(0, -1).every((lease) => lease.disposed)).toBe(
        true,
      ),
    );
    armed = true;
    list.scrollIntoView(1);
    await vi.waitFor(() => expect(release).toBeDefined());
    list.scrollAway(0);
    expect(attention(alerted.id)).toMatchObject({
      unread: false,
      viewing: false,
    });
    delivery.present();
    await flush();
    expect(h.show).not.toHaveBeenCalled();
  } finally {
    armed = false;
    delivery.present();
    release?.();
  }
});
