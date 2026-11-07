import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import { watchPageErrors } from "./page-errors.mjs";
import { readFile } from "node:fs/promises";

const photos = JSON.parse(
  await readFile(
    new URL("../fixtures/gallery-latency/photos.json", import.meta.url),
    "utf8",
  ),
);
// The fixture's relay URLs repeat the photo's number 64 times.
const relayUrl = (n, thumb = false) =>
  `https://relay.test/media/${`${n}`.repeat(64)}${thumb ? ".thumb" : ""}.jpg`;
const mediaUrl = (n, thumb) =>
  `/api/relay/media?url=${encodeURIComponent(relayUrl(n, thumb))}`;

function picture(n, thumb) {
  const [width, height] = photos[n - 1].dim.split("x").map(Number);
  const scale = thumb ? 320 / Math.max(width, height) : 1;
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="hsl(${photos[n - 1].hue} 60% 45%)"/><text x="50%" y="50%" font-size="${h / 3}" text-anchor="middle" dominant-baseline="middle" fill="white">${n}</text></svg>`;
}

/** Serves the fixture's photos through the relay media path. Thumbnails and
 * the originals in `free` respond at once; the rest wait for `release()`.
 * Vite middleware rather than page.route keeps the HTTP cache realistic. */
async function galleryServer(free) {
  const requests = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const server = await createServer({
    configFile: false,
    envFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    plugins: [
      {
        name: "gallery-latency-media",
        configureServer(vite) {
          vite.middlewares.use("/api/relay/media", async (req, res, next) => {
            const target =
              new URL(req.url ?? "", "http://fixture.local").searchParams.get(
                "url",
              ) ?? "";
            const match = /\/media\/(\d)\d{63}(\.thumb)?\.jpg$/.exec(target);
            if (!match) return next();
            const entry = {
              photo: Number(match[1]),
              thumb: !!match[2],
              state: "pending",
            };
            requests.push(entry);
            res.on("close", () => {
              if (!res.writableFinished) entry.state = "aborted";
            });
            if (!entry.thumb && !free.has(entry.photo)) await gate;
            if (entry.state === "aborted") return;
            const body = picture(entry.photo, entry.thumb);
            res.writeHead(200, {
              "Content-Type": "image/svg+xml",
              "Content-Length": Buffer.byteLength(body),
              "Cache-Control": "private, max-age=31536000, immutable",
            });
            res.end(body, () => {
              entry.state = "served";
            });
          });
        },
      },
    ],
  });
  await server.listen();
  return {
    url: `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/gallery-latency.html`,
    // Distinct states of an original's requests: an engine may or may not
    // share one request between a preload and the visible image.
    originals: (photo) => [
      ...new Set(
        requests
          .filter((entry) => entry.photo === photo && !entry.thumb)
          .map((entry) => entry.state),
      ),
    ],
    thumbnails: () => requests.filter((entry) => entry.thumb),
    release: () => release(),
    close: () => server.close(),
  };
}

// Records every image given an original's source, so a test can ask whether
// any image still holds one: the gallery cancels a request by clearing it.
function recordOriginalHolders(page) {
  return page.addInitScript(() => {
    const given = new Map();
    const note = (image, value) => {
      const photo = /%2F(\d)\d{63}\.jpg$/.exec(String(value))?.[1];
      if (!photo) return;
      if (!given.has(photo)) given.set(photo, new Set());
      given.get(photo).add(image);
    };
    const src = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "src",
    );
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      ...src,
      set(value) {
        note(this, value);
        src.set.call(this, value);
      },
    });
    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (this instanceof HTMLImageElement && name === "src") note(this, value);
      return setAttribute.call(this, name, value);
    };
    window.originalHolders = (photo) => {
      const images = [...(given.get(`${photo}`) ?? [])];
      return {
        requested: images.length > 0,
        holding: images.filter((image) =>
          /%2F\d{64}\.jpg$/.test(image.getAttribute("src") ?? ""),
        ).length,
      };
    };
  });
}
const holders = (page, photo) =>
  page.evaluate((photo) => window.originalHolders(photo), photo);

test("gallery navigation shows each chosen photo within a frame and cancels skipped originals", async ({
  page,
  browserName,
}) => {
  const pageErrors = watchPageErrors(page);
  // The thread grid shows photos 1–4; the others wait at the relay.
  const server = await galleryServer(new Set([1, 2, 3, 4]));
  try {
    await recordOriginalHolders(page);
    await page.goto(server.url);
    const tiles = page.locator("[data-media-preview]");
    for (let tile = 0; tile < 4; tile++)
      await expect(tiles.nth(tile)).toHaveAttribute("data-image-ready", "true");
    await tiles.first().click();
    const stage = page.getByRole("group", { name: "Image gallery" });
    await expect(stage).toBeVisible();
    await expect(
      page.locator("[data-review-opening], [data-review-pending]"),
    ).toHaveCount(0);
    // Opening the viewer prefetches every thumbnail. Barrier: each decodes
    // from the cache, with no further request.
    await expect
      .poll(
        () =>
          server.thumbnails().filter(({ state }) => state === "served").length,
      )
      .toBe(photos.length);
    await page.evaluate(
      (sources) =>
        Promise.all(
          sources.map((source) =>
            Object.assign(new Image(), { src: source }).decode(),
          ),
        ),
      photos.map((_, index) => mediaUrl(index + 1, true)),
    );
    expect(server.thumbnails()).toHaveLength(photos.length);

    // The frame after each press: the counter, and the photo whose pixels the
    // arriving picture shows.
    await page.evaluate(() => {
      const photo = (element) => /%2F(\d)\d{63}/.exec(element.src)?.[1];
      const painted = (element) =>
        element?.complete &&
        element.naturalWidth > 0 &&
        getComputedStyle(element).visibility === "visible";
      window.galleryFrames = [];
      document.addEventListener(
        "keydown",
        () =>
          requestAnimationFrame(() => {
            const view = document.querySelector('[aria-label="Image gallery"]');
            const original = view.querySelector("img[data-review-media]");
            const preview = view.querySelector(
              "[data-gallery-preview]:not([data-gallery-departing])",
            );
            const shown =
              preview && !preview.hasAttribute("data-gallery-ready")
                ? preview.dataset.galleryPreview === "thumbnail" &&
                  painted(preview)
                  ? `thumbnail ${photo(preview)}`
                  : `unpainted ${preview.dataset.galleryPreview}`
                : painted(original)
                  ? `photo ${photo(original)}`
                  : "nothing";
            window.galleryFrames.push(
              `${view.querySelector("[aria-live]").textContent}: ${shown}`,
            );
          }),
        true,
      );
    });
    // Press again as soon as the frame is recorded, well inside the slide.
    for (let press = 1; press < photos.length; press++) {
      await page.keyboard.press("ArrowRight");
      await expect
        .poll(() => page.evaluate(() => window.galleryFrames.length))
        .toBe(press);
    }
    expect(await page.evaluate(() => window.galleryFrames)).toEqual(
      photos
        .slice(1)
        .map((_, index) =>
          expect.stringMatching(
            new RegExp(`^${index + 2} / 8: (photo|thumbnail) ${index + 2}$`),
          ),
        ),
    );
    // Photos 5 and 6 were requested ahead and visited, then left two behind,
    // so no image holds them.
    for (const skipped of [5, 6])
      await expect
        .poll(() => holders(page, skipped))
        .toEqual({ requested: true, holding: 0 });
    // Chromium then aborts the request. WebKit finishes loading an image whose
    // source was cleared into its memory cache, so it frees no connection.
    if (browserName === "chromium")
      for (const skipped of [5, 6])
        await expect.poll(() => server.originals(skipped)).toEqual(["aborted"]);

    server.release();
    const original = stage.locator("img[data-review-media]");
    await expect(original).toHaveAttribute(
      "src",
      mediaUrl(photos.length, false),
    );
    await expect
      .poll(() =>
        original.evaluate(
          (element) => element.complete && element.naturalWidth > 0,
        ),
      )
      .toBe(true);
    await expect(original).not.toHaveAttribute("data-gallery-loading");
    await expect(
      stage.locator(
        "[data-gallery-departing], [data-gallery-preview]:not([data-gallery-ready])",
      ),
    ).toHaveCount(0);
    // The previous photo stays in the preload window; the current one loads.
    for (const kept of [7, 8])
      await expect.poll(() => server.originals(kept)).toEqual(["served"]);
    if (browserName === "chromium")
      for (const skipped of [5, 6])
        expect(server.originals(skipped)).toEqual(["aborted"]);
    expect(server.thumbnails()).toHaveLength(photos.length);
    expect(pageErrors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});

// The entrance's chrome fade would override the preview's ready opacity; only
// computed style shows which wins.
test("opening a photo that is still loading grows its original without showing its thumbnail", async ({
  page,
}) => {
  const pageErrors = watchPageErrors(page);
  // Photo 1's original waits at the relay, so its viewer opens pending.
  const server = await galleryServer(new Set([2, 3, 4]));
  try {
    await page.goto(server.url);
    const tiles = page.locator("[data-media-preview]");
    for (let tile = 1; tile < 4; tile++)
      await expect(tiles.nth(tile)).toHaveAttribute("data-image-ready", "true");
    await tiles.first().click();
    await expect(page.locator("[data-review-pending]")).toHaveCount(1);
    const stage = page.getByRole("group", { name: "Image gallery" });
    const preview = stage.locator("[data-gallery-preview]");
    await expect(preview).toHaveAttribute("src", mediaUrl(1, true));
    await expect
      .poll(() =>
        preview.evaluate(
          (element) => element.complete && element.naturalWidth > 0,
        ),
      )
      .toBe(true);
    // Each frame of the entrance: the preview's opacity.
    await page.evaluate(() => {
      window.openingOpacities = [];
      const sample = () => {
        const element = document.querySelector("[data-gallery-preview]");
        if (element && document.querySelector("[data-review-opening]"))
          window.openingOpacities.push(
            Number(getComputedStyle(element).opacity),
          );
        if (!window.openingSettled) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    server.release();
    // Nothing is opening while the original is pending.
    await expect(page.locator("[data-review-pending]")).toHaveCount(0);
    await expect(page.locator("[data-review-opening]")).toHaveCount(0);
    const opacities = await page.evaluate(() => {
      window.openingSettled = true;
      return window.openingOpacities;
    });
    await expect(preview).toHaveAttribute("data-gallery-ready", "");
    await expect(preview).toHaveCSS("opacity", "0");
    expect(opacities.length).toBeGreaterThan(0);
    expect(Math.max(...opacities)).toBe(0);
    expect(pageErrors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});
