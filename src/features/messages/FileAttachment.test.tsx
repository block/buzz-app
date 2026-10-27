// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { downloadNativeMedia } from "./native-download";
import { FileAttachment, formatFileSize } from "./FileAttachment";

vi.mock("./native-download", () => ({ downloadNativeMedia: vi.fn() }));

const proxySource = "/api/relay/media?url=https%3A%2F%2Ffixture.test%2Ffile";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});

it.each([
  [1, "1 B"],
  [1023, "1023 B"],
  [1024, "1 KB"],
  [1536, "2 KB"],
  [1024 * 1024, "1 MB"],
  [1024 * 1024 * 1024, "1 GB"],
])("formats file sizes at unit boundaries", (size, label) => {
  expect(formatFileSize(size)).toBe(label);
});

it("falls back to a mime-derived file label", () => {
  render(
    <FileAttachment
      attachment={{
        url: "https://fixture.test/file",
        kind: "file",
        mime: "application/pdf",
      }}
      source={proxySource}
      onOpenLink={() => false}
    />,
  );
  expect(
    screen.getByRole("link", { name: "Download PDF file" }),
  ).toHaveAttribute("href", proxySource);
  expect(screen.getByText("PDF file")).toBeInTheDocument();
  expect(screen.getByText("Download file")).toBeInTheDocument();
});

it("falls back to a generic file label", () => {
  render(
    <FileAttachment
      attachment={{ url: "https://fixture.test/file", kind: "file" }}
      source={proxySource}
      onOpenLink={() => false}
    />,
  );
  expect(
    screen.getByRole("link", { name: "Download File" }),
  ).toBeInTheDocument();
});

it("keeps nameless downloads on the media href", () => {
  render(
    <FileAttachment
      attachment={{ url: "https://fixture.test/file", kind: "file" }}
      source={proxySource}
      onOpenLink={() => false}
    />,
  );
  expect(screen.getByRole("link", { name: "Download File" })).toHaveAttribute(
    "href",
    proxySource,
  );
  expect(screen.getByRole("link", { name: "Download File" })).toHaveAttribute(
    "download",
    "",
  );
});

it("renders long names as the title while keeping full download semantics", () => {
  const name = `${"Very long report name ".repeat(12)}.pdf`;
  render(
    <FileAttachment
      attachment={{
        url: "https://fixture.test/file",
        kind: "file",
        name,
        size: 1536,
      }}
      source={proxySource}
      onOpenLink={() => false}
    />,
  );
  const link = screen.getByRole("link", { name: `Download ${name}` });
  expect(link).toHaveAttribute("download", name);
  expect(link).toHaveAttribute("title", name);
  expect(screen.getByText("2 KB")).toBeInTheDocument();
});

it("opens external https sources through the opener pattern without download affordance", () => {
  const source = "https://files.example/report.pdf";
  const open = vi.fn(() => true);
  render(
    <FileAttachment
      attachment={{
        url: source,
        kind: "file",
        name: "report.pdf",
      }}
      source={source}
      onOpenLink={open}
    />,
  );
  const link = screen.getByRole("link", { name: "Open report.pdf" });
  expect(link).toHaveAttribute("href", source);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noreferrer");
  expect(link).not.toHaveAttribute("download");
  expect(screen.getByText("Open file")).toBeInTheDocument();
  expect(fireEvent.click(link)).toBe(false);
  expect(open).toHaveBeenCalledWith(source);
});

it("renders unopenable file sources as unavailable", () => {
  render(
    <FileAttachment
      attachment={{
        url: "https://fixture.test/file",
        kind: "file",
        name: "file.pdf",
      }}
      source="blob:https://fixture.test/file"
      onOpenLink={() => false}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("File unavailable");
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

it.each(["application/octet-stream"])(
  "does not derive noisy labels from %s",
  (mime) => {
    render(
      <FileAttachment
        attachment={{ url: "https://fixture.test/file", kind: "file", mime }}
        source={proxySource}
        onOpenLink={() => false}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Download File" }),
    ).toBeInTheDocument();
    expect(screen.getByText("File")).toBeInTheDocument();
  },
);

const nativeSource = `buzz-media://localhost/${encodeURIComponent(`https://relay.test/media/${"a".repeat(64)}.pdf`)}`;

it("keeps preview and native download as separate keyboard actions", async () => {
  vi.mocked(downloadNativeMedia).mockClear().mockResolvedValue(undefined);
  const preview = vi.fn();
  render(
    <FileAttachment
      attachment={{
        url: "https://relay.test/file",
        kind: "file",
        name: "notes.md",
        size: 132,
      }}
      source={nativeSource}
      onOpenLink={() => false}
      onPreview={preview}
      typeLabel="Markdown"
    />,
  );
  const user = userEvent.setup();
  await user.tab();
  expect(
    screen.getByRole("button", { name: "Preview notes.md" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(preview).toHaveBeenCalledOnce();
  expect(downloadNativeMedia).not.toHaveBeenCalled();
  await user.tab();
  expect(
    screen.getByRole("button", { name: "Download notes.md" }),
  ).toHaveFocus();
  expect(screen.getByText("Markdown · 132 B")).toBeInTheDocument();
  await user.keyboard("{Enter}");
  expect(downloadNativeMedia).toHaveBeenCalledWith(nativeSource, "notes.md");
  expect(preview).toHaveBeenCalledOnce();
  expect(await screen.findByText("Saved to Downloads")).toBeInTheDocument();
});

it("downloads authenticated native documents through the host without navigating", async () => {
  vi.mocked(downloadNativeMedia).mockResolvedValue(undefined);
  const open = vi.fn(() => false);
  render(
    <FileAttachment
      attachment={{
        url: "https://relay.test/media/file",
        kind: "file",
        name: "report.pdf",
      }}
      source={nativeSource}
      onOpenLink={open}
    />,
  );
  const link = screen.getByRole("button", { name: "Download report.pdf" });
  expect(link).not.toHaveAttribute("href");
  expect(screen.getByText("Download file")).toBeInTheDocument();
  fireEvent.click(link);
  expect(open).not.toHaveBeenCalled();
  expect(downloadNativeMedia).toHaveBeenCalledWith(nativeSource, "report.pdf");
  await screen.findByText("Saved to Downloads");
});

it.each([
  `buzz-media://evil.test/${encodeURIComponent(`https://relay.test/media/${"a".repeat(64)}`)}`,
  `buzz-media://localhost/${encodeURIComponent("https://relay.test/query")}`,
])("does not offer a download for native lookalike %s", (source) => {
  render(
    <FileAttachment
      attachment={{ url: "https://relay.test/file", kind: "file" }}
      source={source}
      onOpenLink={() => false}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("File unavailable");
  expect(screen.queryByRole("link")).toBeNull();
});

it("reports native download failures without navigating", async () => {
  vi.mocked(downloadNativeMedia).mockRejectedValueOnce(
    new Error("unavailable"),
  );
  render(
    <FileAttachment
      attachment={{
        url: "https://relay.test/file",
        kind: "file",
        name: "report.pdf",
      }}
      source={nativeSource}
      onOpenLink={() => false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Download report.pdf" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn’t download report.pdf. Try again.",
    ),
  );
});

function heldDownload() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const file = {
  url: "https://relay.test/file",
  kind: "file" as const,
  name: "report.pdf",
  size: 1024,
};

const downloadLayouts = [
  { layout: "card", layoutProps: { variant: "card" } },
  { layout: "preview", layoutProps: { variant: "card", onPreview: vi.fn() } },
  { layout: "summary", layoutProps: { variant: "summary" } },
] as const;

it.each(downloadLayouts)(
  "preserves focus and blocks repeat saves while pending, then announces success ($layout)",
  async ({ layout, layoutProps }) => {
    vi.useFakeTimers();
    const download = heldDownload();
    vi.mocked(downloadNativeMedia).mockReturnValueOnce(download.promise);
    render(
      <FileAttachment
        {...layoutProps}
        attachment={file}
        source={nativeSource}
        onOpenLink={() => false}
      />,
    );
    const button = screen.getByRole("button", {
      name: "Download report.pdf",
    });
    button.focus();
    fireEvent.click(button);
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    expect(screen.getByText("Downloading…")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Downloading report.pdf",
    );
    if (layout === "preview") {
      const preview = screen.getByRole("button", {
        name: "Preview report.pdf",
      });
      expect(preview).not.toBeDisabled();
      fireEvent.click(preview);
      if ("onPreview" in layoutProps)
        expect(layoutProps.onPreview).toHaveBeenCalledOnce();
    }
    fireEvent.click(button);
    expect(downloadNativeMedia).toHaveBeenCalledTimes(1);
    await act(async () => download.resolve());
    expect(screen.getByText("Saved to Downloads")).toBeInTheDocument();
    expect(button).not.toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saved report.pdf to Downloads",
    );
    act(() => vi.advanceTimersByTime(3999));
    expect(screen.getByText("Saved to Downloads")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(
      screen.getByText(layout === "card" ? "1 KB" : "File · 1 KB"),
    ).toBeInTheDocument();
    vi.mocked(downloadNativeMedia).mockResolvedValueOnce(undefined);
    fireEvent.click(button);
    await act(async () => {});
    expect(downloadNativeMedia).toHaveBeenCalledTimes(2);
  },
);

it.each(downloadLayouts)(
  "keeps a failed download on the card and recovers through retry ($layout)",
  async ({ layoutProps }) => {
    const failed = heldDownload();
    const retried = heldDownload();
    vi.mocked(downloadNativeMedia)
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retried.promise);
    render(
      <FileAttachment
        {...layoutProps}
        attachment={file}
        source={nativeSource}
        onOpenLink={() => false}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Download report.pdf" }),
    );
    await act(async () => failed.reject(new Error("unavailable")));
    const retry = screen.getByRole("button", {
      name: "Retry download report.pdf",
    });
    expect(screen.getByText("Couldn’t download · Retry")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveClass("sr-only");
    fireEvent.click(retry);
    expect(screen.getByText("Downloading…")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => retried.resolve());
    expect(screen.getByText("Saved to Downloads")).toBeInTheDocument();
    expect(downloadNativeMedia).toHaveBeenCalledTimes(2);
  },
);

it.each(
  downloadLayouts.flatMap((layout) =>
    ["success", "failure"].map((result) => ({ ...layout, result })),
  ),
)(
  "retires an old source's pending $result result ($layout)",
  async ({ layout, layoutProps, result }) => {
    const old = heldDownload();
    vi.mocked(downloadNativeMedia).mockReturnValueOnce(old.promise);
    const { rerender } = render(
      <FileAttachment
        {...layoutProps}
        attachment={file}
        source={nativeSource}
        onOpenLink={() => false}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Download report.pdf" }),
    );
    const replacement = nativeSource.replace(".pdf", ".txt");
    rerender(
      <FileAttachment
        {...layoutProps}
        attachment={file}
        source={replacement}
        onOpenLink={() => false}
      />,
    );
    await act(async () =>
      result === "success"
        ? old.resolve()
        : old.reject(new Error("old failure")),
    );
    expect(
      screen.getByText(layout === "card" ? "1 KB" : "File · 1 KB"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download report.pdf" }),
    ).not.toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  },
);
