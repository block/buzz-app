// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useReading } from "../messages/use-reading";
import { flush } from "../relay/testing";
import { cleanups, setup } from "./messages-testing";

afterEach(async () => {
  cleanup();
  for (const stop of cleanups.splice(0)) await stop();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each(["in view", "window blur", "scroll away"] as const)(
  "Notify while viewing: after the list's own dwell read, the alert follows the view (%s)",
  async (state) => {
    const h = await setup(undefined, undefined, undefined, undefined, true);
    h.notifications.updatePreferences({ notifyWhileViewing: true });
    const row = h.make("read before presentation");
    // Hold delivery at its permission probe, as a slow presentation would.
    let present!: () => void;
    h.permission.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          present = () => resolve("granted");
        }),
    );
    h.emit([row], "live");
    await vi.waitFor(() => expect(present).toBeDefined());
    // The real reading hook over a focused, fully visible message list.
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
    const item = document.createElement("div");
    item.dataset.messageId = row.id;
    list.append(item);
    document.body.append(list);
    list.focus();
    vi.spyOn(list, "getClientRects").mockReturnValue([
      new DOMRect(0, 0, 500, 500),
    ] as unknown as DOMRectList);
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 500, 500),
    );
    const bounds = vi
      .spyOn(item, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 100, 400, 100));
    renderHook(useReading, {
      initialProps: {
        session: h.owner.session,
        channelId: "room",
        scroller: { current: list },
        settled: { current: true },
      },
    });
    const attention = () => h.owner.session.unread.attention("room", row.id);
    // Dwell completes and its durable read, including lease cleanup, settles.
    await vi.waitFor(() => expect(attention().unread).toBe(false));
    // The read's lease is released after its write; give that cleanup time.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(attention()).toMatchObject({ unread: false, viewing: true });
    if (state === "window blur") window.dispatchEvent(new Event("blur"));
    if (state === "scroll away") {
      bounds.mockReturnValue(new DOMRect(0, 600, 400, 100));
      list.dispatchEvent(new Event("scroll"));
    }
    present();
    await flush();
    expect(h.show).toHaveBeenCalledTimes(state === "in view" ? 1 : 0);
  },
);
