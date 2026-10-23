// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { downloadNativeMedia } from "./native-download";
import { FileAttachment, formatFileSize } from "./FileAttachment";

vi.mock("./native-download", () => ({ downloadNativeMedia: vi.fn() }));

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const proxySource = "/api/relay/media?url=https%3A%2F%2Ffixture.test%2Ffile";

afterEach(() => {
  cleanup();
  vi.mocked(downloadNativeMedia).mockReset();
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

it("shows pending and completed native downloads without duplicate requests", async () => {
  const request = deferred();
  vi.mocked(downloadNativeMedia).mockReturnValueOnce(request.promise);
  const open = vi.fn(() => false);
  const view = render(
    <FileAttachment
      attachment={{
        url: "https://relay.test/media/file",
        kind: "file",
        name: "report.pdf",
      }}
      source={nativeSource}
      onOpenLink={open}
    />,
    { wrapper: ToastProvider },
  );
  const button = screen.getByRole("button", { name: "Download report.pdf" });
  expect(button).not.toHaveAttribute("href");
  expect(screen.getByText("Download file")).toBeInTheDocument();
  const user = userEvent.setup();
  button.focus();
  await user.keyboard("{Enter}");
  try {
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveFocus();
    expect(screen.getByText("Downloading…")).toBeInTheDocument();
    await user.keyboard("{Enter} ");
    fireEvent.click(button);
    expect(downloadNativeMedia).toHaveBeenCalledTimes(1);
    expect(downloadNativeMedia).toHaveBeenCalledWith(
      nativeSource,
      "report.pdf",
    );
    expect(open).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("dialog", { name: "File saved to Downloads" }),
    ).toBeNull();
  } finally {
    await act(() => request.resolve());
  }
  const notice = await screen.findByRole("dialog", {
    name: "File saved to Downloads",
  });
  expect(button).not.toHaveAttribute("aria-disabled", "true");
  expect(button).not.toHaveAttribute("aria-busy", "true");
  expect(screen.queryByText("Downloading…")).toBeNull();
  view.rerender(null);
  expect(notice).toBeInTheDocument();
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

it("keeps native download failures visible and allows retry", async () => {
  const request = deferred();
  const retry = deferred();
  vi.mocked(downloadNativeMedia)
    .mockReturnValueOnce(request.promise)
    .mockReturnValueOnce(retry.promise);
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
    { wrapper: ToastProvider },
  );
  const button = screen.getByRole("button", { name: "Download report.pdf" });
  fireEvent.click(button);
  await act(() => request.reject(new Error("unavailable")));
  expect(await screen.findByRole("alert")).toHaveTextContent("Download failed");
  expect(button).not.toHaveAttribute("aria-disabled", "true");
  expect(
    screen.queryByRole("dialog", { name: "File saved to Downloads" }),
  ).toBeNull();
  fireEvent.click(button);
  try {
    expect(screen.queryByRole("alert")).toBeNull();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(downloadNativeMedia).toHaveBeenCalledTimes(2);
  } finally {
    await act(() => retry.resolve());
  }
  expect(
    await screen.findByRole("dialog", { name: "File saved to Downloads" }),
  ).toBeInTheDocument();
  expect(button).not.toHaveAttribute("aria-disabled", "true");
});

it.each([false, true])(
  "keeps a remounted card pending and reports failure=%s once",
  async (fails) => {
    const request = deferred();
    vi.mocked(downloadNativeMedia).mockReturnValueOnce(request.promise);
    const card = (key: string) => (
      <FileAttachment
        key={key}
        attachment={{
          url: "https://relay.test/file",
          kind: "file",
          name: "report.pdf",
        }}
        source={nativeSource}
        onOpenLink={() => false}
      />
    );
    const view = render(card("before"), { wrapper: ToastProvider });
    fireEvent.click(
      screen.getByRole("button", { name: "Download report.pdf" }),
    );
    view.rerender(null);
    view.rerender(card("after"));
    const button = screen.getByRole("button", { name: "Download report.pdf" });
    try {
      expect(button).toHaveAttribute("aria-busy", "true");
      expect(button).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(button);
      expect(downloadNativeMedia).toHaveBeenCalledTimes(1);
    } finally {
      await act(() =>
        fails ? request.reject(new Error("offline")) : request.resolve(),
      );
    }
    expect(button).not.toHaveAttribute("aria-busy", "true");
    if (fails) {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Download failed",
      );
      expect(
        screen.queryByRole("dialog", { name: "File saved to Downloads" }),
      ).toBeNull();
    } else {
      expect(
        await screen.findAllByRole("dialog", {
          name: "File saved to Downloads",
        }),
      ).toHaveLength(1);
    }
  },
);

it("shares pending state across cards but not different destinations", async () => {
  const first = deferred();
  const other = deferred();
  vi.mocked(downloadNativeMedia)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(other.promise);
  const card = (name: string, source = nativeSource) => (
    <FileAttachment
      attachment={{ url: "https://relay.test/file", kind: "file", name }}
      source={source}
      onOpenLink={() => false}
    />
  );
  render(
    <>
      {card("report.pdf")}
      {card("report.pdf")}
      {card("copy.pdf")}
    </>,
    { wrapper: ToastProvider },
  );
  const buttons = screen.getAllByRole("button", {
    name: "Download report.pdf",
  });
  const [firstButton, secondButton] = buttons;
  if (!firstButton || !secondButton) throw new Error("Missing mirrored cards");
  fireEvent.click(firstButton);
  try {
    expect(buttons[1]).toHaveAttribute("aria-busy", "true");
    fireEvent.click(secondButton);
    expect(downloadNativeMedia).toHaveBeenCalledTimes(1);
    const copy = screen.getByRole("button", { name: "Download copy.pdf" });
    expect(copy).not.toHaveAttribute("aria-busy", "true");
    fireEvent.click(copy);
    expect(downloadNativeMedia).toHaveBeenCalledTimes(2);
  } finally {
    await act(() => {
      first.resolve();
      other.resolve();
    });
  }
  expect(buttons[0]).not.toHaveAttribute("aria-busy", "true");
  expect(buttons[1]).not.toHaveAttribute("aria-busy", "true");
});

it("restores a failure that settled while its card was absent and allows retry", async () => {
  const request = deferred();
  const retry = deferred();
  vi.mocked(downloadNativeMedia)
    .mockReturnValueOnce(request.promise)
    .mockReturnValueOnce(retry.promise);
  const card = (
    <StrictMode>
      <FileAttachment
        attachment={{
          url: "https://relay.test/file",
          kind: "file",
          name: "absence-report.pdf",
        }}
        source={nativeSource}
        onOpenLink={() => false}
      />
    </StrictMode>
  );
  const view = render(card, { wrapper: ToastProvider });
  fireEvent.click(
    screen.getByRole("button", { name: "Download absence-report.pdf" }),
  );
  view.rerender(null);
  await act(() => request.reject(new Error("offline")));
  view.rerender(card);
  expect(await screen.findByRole("alert")).toHaveTextContent("Download failed");
  fireEvent.click(
    screen.getByRole("button", { name: "Download absence-report.pdf" }),
  );
  try {
    expect(screen.queryByRole("alert")).toBeNull();
    expect(downloadNativeMedia).toHaveBeenCalledTimes(2);
  } finally {
    await act(() => retry.resolve());
  }
  expect(
    await screen.findByRole("dialog", { name: "File saved to Downloads" }),
  ).toBeInTheDocument();
});

it("bounds absent failures while keeping visible errors", async () => {
  const requests = Array.from({ length: 102 }, () => deferred());
  for (const request of requests)
    vi.mocked(downloadNativeMedia).mockReturnValueOnce(request.promise);
  const card = (index: number) => (
    <FileAttachment
      key={index}
      attachment={{
        url: "https://relay.test/file",
        kind: "file",
        name: `cache-${index}.pdf`,
      }}
      source={nativeSource}
      onOpenLink={() => false}
    />
  );
  const view = render(
    requests.map((_, index) => card(index)),
    {
      wrapper: ToastProvider,
    },
  );
  for (const button of screen.getAllByRole("button", {
    name: /Download cache-/,
  }))
    fireEvent.click(button);
  view.rerender(card(0));
  await act(() => {
    for (const request of requests) request.reject(new Error("offline"));
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Download failed");
  view.rerender(card(1));
  expect(screen.queryByRole("alert")).toBeNull();
  view.rerender(card(101));
  expect(await screen.findByRole("alert")).toHaveTextContent("Download failed");
});
