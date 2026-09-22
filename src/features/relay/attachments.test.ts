import { expect, it } from "vitest";
import { attachmentMarkdown, validateUploadResult } from "./attachments";
const hash = "a".repeat(64);
const good = {
  url: `https://relay.test/media/${hash}.txt`,
  size: 3,
  type: "text/plain",
  sha256: hash,
};
it("rejects upload results outside the exact destination, size and content hash", () => {
  expect(validateUploadResult(good, "https://relay.test", 3, hash)).toEqual(
    good,
  );
  for (const patch of [
    { url: `https://evil.test/media/${hash}.txt` },
    { url: `https://user@relay.test/media/${hash}.txt` },
    { url: `https://relay.test/media/${hash}.txt?x=1` },
    { size: 4 },
    { sha256: "b".repeat(64) },
    { type: "text/html; charset=utf8" },
    { url: "https://[" },
  ])
    expect(() =>
      validateUploadResult(
        { ...good, ...patch },
        "https://relay.test",
        3,
        hash,
      ),
    ).toThrow();
});
it("escapes filenames and does not make generic files or active images inline", () => {
  expect(attachmentMarkdown("[click](evil)\n.txt", good)).toContain(
    "\\[click\\]\\(evil\\) .txt",
  );
  expect(
    attachmentMarkdown("document.html", { ...good, type: "text/html" }),
  ).toMatch(/^\[/);
  expect(
    attachmentMarkdown("art.svg", { ...good, type: "image/svg+xml" }),
  ).toMatch(/^\[/);
  expect(
    attachmentMarkdown("photo.png", { ...good, type: "image/png" }),
  ).toMatch(/^!\[/);
});
