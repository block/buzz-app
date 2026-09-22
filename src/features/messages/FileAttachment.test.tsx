// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FileAttachment, formatFileSize } from "./FileAttachment";

const proxySource = "/api/relay/media?url=https%3A%2F%2Ffixture.test%2Ffile";

afterEach(cleanup);

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

it.each(["application/octet-stream", "application/vnd.ms-excel"])(
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
