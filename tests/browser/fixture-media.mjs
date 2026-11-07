const fixtureImage = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#666"/></svg>`;

/** Serves the messages fixture's `https://fixture.test/media/` images, so
    only a test that marks one `missing` sees a failed image. */
export function fixtureMediaPlugin(media = {}) {
  return {
    name: "messages-fixture-media",
    configureServer(server) {
      server.middlewares.use("/api/relay/media", (req, res, next) => {
        if (req.method !== "GET") return next();
        const url = new URL(req.url ?? "", "http://fixture.local");
        const target = url.searchParams.get("url") ?? "";
        if (!target.startsWith("https://fixture.test/media/")) return next();
        if (media.missing?.(target)) {
          res.writeHead(404);
          res.end("missing");
          return;
        }
        res.writeHead(200, {
          "Content-Type": "image/svg+xml",
          "Content-Length": Buffer.byteLength(fixtureImage),
        });
        res.end(fixtureImage);
      });
    },
  };
}
