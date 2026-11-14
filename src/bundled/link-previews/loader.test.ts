import { describe, expect, it, vi } from "vitest";
import { createLoader } from "./loader";
import { previewable, wantsCard } from "./safety";

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
  it("leaves links Buzz already labels inline without a card", () => {
    expect(wantsCard("https://example.com/a")).toBe(true);
    for (const url of [
      "https://github.com/block/buzz-app/pull/1",
      "https://gist.github.com/a/b",
      "https://docs.google.com/document/d/x",
      "https://www.figma.com/file/x",
      "https://www.youtube.com/watch?v=x",
      "https://app.builderlab.xyz/a/av_Q430oIuy2pHC345U08CVjg",
    ])
      expect(wantsCard(url), url).toBe(false);
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
    expect(loader.peek("https://short.example.com/x")).toBeUndefined();
    const page = await loader.page("https://short.example.com/x").value;
    expect(loader.peek("https://short.example.com/x")).toEqual(page);
    expect(page).toEqual({
      url: "https://short.example.com/final",
      title: "Final",
      siteName: "Example",
      image: "https://img.example.com/a.png",
    });
    await loader.page("https://short.example.com/x").value;
    expect(readPage).toHaveBeenCalledTimes(2);
  });

  it("refuses a redirect to a local name before asking for it", async () => {
    const readPage = vi.fn(async () => ({
      status: 302,
      location: "https://intranet.corp/secret",
    }));
    const loader = createLoader({ readPage });
    expect(await loader.page("https://example.com/").value).toBeNull();
    expect(readPage).toHaveBeenCalledTimes(1);
  });

  it("keeps a failure for a cooldown, then reads the page again", async () => {
    let time = 0;
    const readPage = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, preview: {} })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ status: 200, preview: { title: "Back" } });
    const loader = createLoader({ readPage }, () => time);
    const url = "https://a.example.com/";
    expect(await loader.page(url).value).toBeNull();
    expect(loader.peek(url)).toBeNull();
    expect(await loader.page(url).value).toBeNull();
    expect(readPage).toHaveBeenCalledTimes(1);
    time += 5 * 60_000 + 1;
    expect(loader.peek(url)).toBeUndefined();
    expect(await loader.page(url).value).toBeNull();
    time += 5 * 60_000 + 1;
    expect((await loader.page(url).value)?.title).toBe("Back");
  });

  it("reads the newest request first and never sends a withdrawn one", async () => {
    const held = new Map<string, () => void>();
    const readPage = vi.fn(
      (url: string) =>
        new Promise<{ status: number; preview: { title: string } }>(
          (resolve) => {
            held.set(url, () =>
              resolve({ status: 200, preview: { title: url } }),
            );
          },
        ),
    );
    const loader = createLoader({ readPage });
    const url = (i: number) => `https://p${i}.example.com/`;
    const leases = Array.from({ length: 10 }, (_, i) => loader.page(url(i)));
    expect(readPage.mock.calls.map(([asked]) => asked)).toEqual(
      [0, 1, 2, 3].map(url),
    );
    for (const i of [4, 5, 6, 7, 8]) leases[i]?.release();
    held.get(url(0))?.();
    await leases[0]?.value;
    await vi.waitFor(() => expect(readPage).toHaveBeenCalledTimes(5));
    expect(readPage).toHaveBeenLastCalledWith(url(9), expect.anything());
    for (const i of [1, 2, 3, 9]) held.get(url(i))?.();
    await Promise.all([1, 2, 3, 9].map((i) => leases[i]?.value));
    expect(readPage).toHaveBeenCalledTimes(5);
  });

  it("keeps one read per page however many pages are waiting", async () => {
    const readPage = vi.fn((_url: string) => new Promise<never>(() => {}));
    const loader = createLoader({ readPage });
    const first = loader.page("https://first.example.com/");
    for (let i = 0; i < 250; i++) loader.page(`https://p${i}.example.com/`);
    const again = loader.page("https://first.example.com/");
    expect(again.value).toBe(first.value);
    expect(
      readPage.mock.calls.filter(
        ([asked]) => asked === "https://first.example.com/",
      ),
    ).toHaveLength(1);
  });

  it("revokes an evicted image only after every card using it lets go", async () => {
    let made = 0;
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation(() => `blob:test/${made++}`);
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    try {
      const requestBytes = vi.fn(async () => ({
        status: 200,
        headers: { "Content-Type": "image/png" },
        body: new Uint8Array([1]),
      }));
      const loader = createLoader({ readPage: vi.fn(), requestBytes });
      const shown = loader.image("https://img.example.com/0.png");
      const others = Array.from({ length: 61 }, (_, i) =>
        loader.image(`https://img.example.com/${i + 1}.png`),
      );
      const src = await shown.src;
      const srcs = await Promise.all(others.map((lease) => lease.src));
      for (const lease of others) lease.release();
      await Promise.resolve();
      expect(src).toMatch(/^blob:test\//);
      expect(revoke).not.toHaveBeenCalledWith(src);
      expect(revoke).toHaveBeenCalledWith(srcs[0]);
      expect(revoke).not.toHaveBeenCalledWith(srcs[60]);
      shown.release();
      await Promise.resolve();
      expect(revoke).toHaveBeenCalledWith(src);
      loader.stop();
      await Promise.resolve();
      expect(revoke).toHaveBeenCalledWith(srcs[60]);
    } finally {
      create.mockRestore();
      revoke.mockRestore();
    }
  });

  it("is unavailable without a page reader", async () => {
    const loader = createLoader(undefined);
    expect(loader.available).toBe(false);
    expect(await loader.page("https://example.com/").value).toBeNull();
  });
});
