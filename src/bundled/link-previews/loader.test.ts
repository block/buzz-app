import { describe, expect, it, vi } from "vitest";
import { createLoader } from "./loader";
import { previewable } from "./safety";

describe("previewable", () => {
  it("allows public HTTPS names only", () => {
    expect(previewable("https://example.com/a")?.href).toBe(
      "https://example.com/a",
    );
    for (const url of [
      "http://example.com/",
      "https://user:pw@example.com/",
      "https://example.com:8443/",
      "https://127.0.0.1/",
      "https://[::1]/",
      "https://0x7f.1/",
      "https://localhost/",
      "https://printer.local/",
      "https://box.tailnet.ts.net/",
      "https://site.example/",
      `https://example.com/${"a".repeat(2048)}`,
    ])
      expect(previewable(url), url).toBeNull();
  });
});

describe("createLoader", () => {
  it("follows checked redirects and keeps the page for the session", async () => {
    const readPage = vi.fn(async (url: string) =>
      url === "https://short.example.com/x"
        ? { status: 301, location: "/final" }
        : {
            status: 200,
            preview: {
              title: "Final",
              image: "https://img.example.com/a.png",
              siteName: "Example",
            },
          },
    );
    const loader = createLoader({ readPage });
    const page = await loader.page("https://short.example.com/x");
    expect(page).toEqual({
      url: "https://short.example.com/final",
      title: "Final",
      siteName: "Example",
      image: "https://img.example.com/a.png",
    });
    await loader.page("https://short.example.com/x");
    expect(readPage).toHaveBeenCalledTimes(2);
  });

  it("refuses a redirect to a local name before asking for it", async () => {
    const readPage = vi.fn(async () => ({
      status: 302,
      location: "https://intranet.corp/secret",
    }));
    const loader = createLoader({ readPage });
    expect(await loader.page("https://example.com/")).toBeNull();
    expect(readPage).toHaveBeenCalledTimes(1);
  });

  it("shows nothing for a page without a title and forgets failures", async () => {
    const readPage = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, preview: {} })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ status: 200, preview: { title: "Back" } });
    const loader = createLoader({ readPage });
    expect(await loader.page("https://a.example.com/")).toBeNull();
    expect(await loader.page("https://a.example.com/")).toBeNull();
    expect((await loader.page("https://a.example.com/"))?.title).toBe("Back");
  });

  it("is unavailable without a page reader", async () => {
    const loader = createLoader(undefined);
    expect(loader.available).toBe(false);
    expect(await loader.page("https://example.com/")).toBeNull();
  });
});
