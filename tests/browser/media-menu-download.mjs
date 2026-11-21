import { expect } from "@playwright/test";

// Native event delivery is the only stub. Production listeners and viewer owners run.
export function installNativeMediaMenu() {
  window.isTauri = true;
  const original = window.__TAURI_INTERNALS__;
  const callbacks = new Map();
  const listeners = new Map();
  let next = 100000;
  window.__TAURI_INTERNALS__ = {
    ...original,
    transformCallback(callback) {
      const id = ++next;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    async invoke(command, args) {
      if (command === "plugin:event|listen") {
        const id = ++next;
        listeners.set(id, args);
        return id;
      }
      if (command === "plugin:event|unlisten") {
        listeners.delete(args.eventId);
        return;
      }
      if (original) return original.invoke(command, args);
      throw new Error(`Unexpected IPC: ${command}`);
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(_event, id) {
      listeners.delete(id);
    },
  };
  window.emitMediaMenuDownload = (payload) => {
    let delivered = 0;
    for (const [id, listener] of listeners) {
      if (listener.event !== "media-menu-download") continue;
      callbacks.get(listener.handler)({ event: listener.event, id, payload });
      delivered++;
    }
    return delivered;
  };
}

export async function nativeMediaMenu(page) {
  await page.addInitScript(installNativeMediaMenu);
}

export async function checkViewerDownloadFeedback(
  page,
  viewer,
  backgroundNotice,
) {
  await page.clock.install();
  // Hold the viewer open past the old host-toast lifetime before each result.
  await page.clock.fastForward(5000);
  const geometry = () =>
    viewer.evaluate((root) => {
      const stage =
        root.querySelector("[data-review-stage]") ?? root.querySelector("img");
      if (!stage) throw new Error("Missing media stage");
      const rect = stage.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
  const resting = await geometry();
  const stableStage = () => expect.poll(geometry).toEqual(resting);
  expect(
    await page.evaluate(() => window.emitMediaMenuDownload("image.png")),
  ).toBe(1);
  await expect(
    viewer.getByRole("status").filter({ hasText: "Saved to Downloads" }),
  ).toBeVisible();
  await expect(backgroundNotice).toBeHidden();
  await stableStage();
  await page.clock.fastForward(4001);
  await expect(
    viewer.getByText("Saved to Downloads", { exact: true }),
  ).toHaveCount(0);
  await stableStage();
  expect(await page.evaluate(() => window.emitMediaMenuDownload(null))).toBe(1);
  const failure = viewer
    .getByRole("alert")
    .filter({ hasText: "Couldn’t download. Try again." });
  await expect(failure).toBeVisible();
  await page.clock.fastForward(4001);
  await expect(failure).toBeVisible();
  await expect(backgroundNotice).toBeHidden();
  await stableStage();
  await expect(viewer).toBeVisible();
  await page.clock.fastForward(2000);
  await expect(failure).toHaveCount(0);
  await stableStage();
  // A later native video result must work after both timers have expired.
  expect(
    await page.evaluate(() => window.emitMediaMenuDownload("video.mp4")),
  ).toBe(1);
  await expect(
    viewer.getByRole("status").filter({ hasText: "Saved to Downloads" }),
  ).toBeVisible();
}
