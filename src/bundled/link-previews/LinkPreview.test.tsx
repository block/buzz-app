// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LinkPreview } from "./LinkPreview";
import type { Loader, Page } from "./loader";
import { splitHost } from "./safety";

afterEach(cleanup);

const loader = (page: Page | null): Loader =>
  ({
    available: true,
    page: vi.fn(() => ({ value: Promise.resolve(page), release: vi.fn() })),
    peek: vi.fn(() => undefined),
    peekImage: vi.fn(() => undefined),
    image: vi.fn(() => ({ src: Promise.resolve(null), release: vi.fn() })),
    stop: vi.fn(),
  }) as unknown as Loader;

it("shows the link's real domain beside the page's own site name", async () => {
  const open = vi.fn(() => true);
  render(
    <LinkPreview
      url="https://www.example.com/post"
      messageId="m"
      open={open}
      loader={loader({
        url: "https://www.example.com/post",
        title: "A post",
        description: "About things",
        siteName: "Example Blog",
      })}
    />,
  );
  const card = await screen.findByRole("link", { name: /A post/ });
  expect(card.getAttribute("href")).toBe("https://www.example.com/post");
  expect(card.textContent).toContain("Example Blog\u00a0·\u00a0example.com");
  expect(screen.getByText("About things")).toBeTruthy();
  expect(fireEvent.click(card)).toBe(false);
  expect(open).toHaveBeenCalledOnce();
});

it("leaves a click Buzz can't open to the browser, and modified clicks alone", async () => {
  const open = vi.fn(() => false);
  render(
    <LinkPreview
      url="https://example.com/"
      messageId="m"
      open={open}
      loader={loader({ url: "https://example.com/", title: "A page" })}
    />,
  );
  const card = await screen.findByRole("link", { name: /A page/ });
  expect(card.getAttribute("target")).toBe("_blank");
  expect(card.getAttribute("rel")).toBe("noopener noreferrer");
  expect(fireEvent.click(card)).toBe(true);
  expect(open).toHaveBeenCalledOnce();
  open.mockReturnValue(true);
  expect(fireEvent.click(card, { ctrlKey: true })).toBe(true);
  expect(fireEvent.click(card, { shiftKey: true })).toBe(true);
  expect(open).toHaveBeenCalledOnce();
});

it("keeps the real domain whole and isolated from the page's site name", async () => {
  const siteName = `\u202ePayPal Secure Account Verification ${"x".repeat(60)}`;
  render(
    <LinkPreview
      url="https://spoof.example.net/"
      messageId="m"
      open={() => true}
      loader={loader({
        url: "https://spoof.example.net/",
        title: "Sign in",
        siteName,
      })}
    />,
  );
  await screen.findByRole("link", { name: /Sign in/ });
  const domain = screen.getByTitle("spoof.example.net");
  expect(domain.tagName).toBe("BDI");
  expect(domain.getAttribute("dir")).toBe("ltr");
  expect(domain.textContent).toBe("spoof.example.net");
  const name = screen.getByText(siteName);
  expect(name.tagName).toBe("BDI");
  expect(name.contains(domain)).toBe(false);
});

it("draws no thumbnail for an image that can't be read, and never takes alt text from the page", async () => {
  const failing = loader({
    url: "https://example.com/",
    title: "No picture",
    image: "https://img.example.com/missing.png",
  });
  const { container } = render(
    <LinkPreview
      url="https://example.com/"
      messageId="m"
      open={() => true}
      loader={failing}
    />,
  );
  await screen.findByRole("link", { name: /No picture/ });
  await vi.waitFor(() => expect(failing.image).toHaveBeenCalled());
  await vi.waitFor(() =>
    expect(container.querySelector("a > span + span")).toBeNull(),
  );
  const shown = loader({
    url: "https://example.com/b",
    title: "Picture",
    image: "https://img.example.com/b.png",
  });
  vi.mocked(shown.peekImage).mockReturnValue("blob:test/b");
  vi.mocked(shown.image).mockReturnValue({
    src: Promise.resolve("blob:test/b"),
    release: vi.fn(),
  });
  render(
    <LinkPreview
      url="https://example.com/b"
      messageId="m"
      open={() => true}
      loader={shown}
    />,
  );
  const img = (
    await screen.findByRole("link", { name: /Picture/ })
  ).querySelector("img");
  expect(img?.getAttribute("alt")).toBe("");
});

it("keeps the card, with the bare link, when the page can't be read", async () => {
  const empty = loader(null);
  render(
    <LinkPreview
      url="https://example.com/a/b"
      messageId="m"
      open={() => true}
      loader={empty}
    />,
  );
  const card = screen.getByRole("link", { name: /example\.com\/a\/b/ });
  expect(card.getAttribute("aria-busy")).toBe("true");
  await vi.waitFor(() => expect(card.getAttribute("aria-busy")).toBeNull());
  expect(screen.getByText("example.com/a/b")).toBeTruthy();
});

it("draws a page it has already read on its first render", () => {
  const read = loader(null);
  vi.mocked(read.peek).mockReturnValue({
    url: "https://example.com/",
    title: "Seen before",
    image: "https://img.example.com/a.png",
  });
  render(
    <LinkPreview
      url="https://example.com/"
      messageId="m"
      open={() => true}
      loader={read}
    />,
  );
  expect(screen.getByRole("link", { name: /Seen before/ })).toBeTruthy();
});

it("splits a hostname so subdomains give way before the registered name", () => {
  expect(splitHost("docs.platform.example-company.com")).toEqual({
    subdomains: "docs.platform.",
    name: "example-company",
    suffix: ".com",
  });
  expect(splitHost("login.bank.co.uk")).toEqual({
    subdomains: "login.",
    name: "bank",
    suffix: ".co.uk",
  });
  expect(splitHost("example.com")).toEqual({
    subdomains: "",
    name: "example",
    suffix: ".com",
  });
});
