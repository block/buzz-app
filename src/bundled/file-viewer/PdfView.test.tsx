// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PageText, PdfDocument } from "./pdf";

const texts = vi.hoisted(() => ({
  pages: [] as (() => Promise<PageText>)[],
}));
vi.mock("./pdf", () => ({
  MAX_PDF_TEXT_CHARS: 5_000_000,
  PdfError: class extends Error {},
  openPdf: async (): Promise<PdfDocument> => ({
    pages: texts.pages.length,
    sizes: texts.pages.map(() => ({ width: 100, height: 100 })),
    text: async () => "",
    pageText: (page) => {
      const read = texts.pages[page - 1];
      if (!read) throw new Error(`No page ${page}`);
      return read();
    },
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
    destroy: async () => {},
  }),
}));

class InView {
  constructor(private readonly report: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.report(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
class Unobserved {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", InView);
  vi.stubGlobal("ResizeObserver", Unobserved);
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("tells screen readers whether a page's text is whole, cut short, empty or unreadable", async () => {
  texts.pages = [
    async () => ({ text: "Whole page", truncated: false }),
    async () => ({ text: "Dense page", truncated: true }),
    async () => ({ text: "", truncated: false }),
    async () => Promise.reject(new Error("worker failed")),
  ];
  const { default: PdfView } = await import("./PdfView");
  render(<PdfView bytes={new Uint8Array()} name="report.pdf" />);
  const page = (number: number) =>
    screen.findByRole("group", { name: `Page ${number} of 4` });
  const expectText = async (number: number, text: string | RegExp) => {
    const group = await page(number);
    await vi.waitFor(() => expect(group).toHaveTextContent(text));
    return group;
  };
  await expectText(1, /^Whole page$/);
  await expectText(
    2,
    "Dense page This page's text continues past what can be read here.",
  );
  await expectText(3, "This page has no text.");
  const failed = await expectText(4, "This page's text couldn't be read.");
  expect(failed).not.toHaveTextContent("no text");
});
