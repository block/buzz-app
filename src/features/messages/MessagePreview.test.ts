import { expect, it } from "vitest";
import { attachmentLabel } from "./MessagePreview";

const media = "https://relay.test/media";

it("names an attachment-only message by what it attaches", () => {
  expect(attachmentLabel([])).toBeUndefined();
  expect(
    attachmentLabel([
      { url: "https://static.klipy.com/thanks.gif", kind: "image" },
    ]),
  ).toBe("GIF");
  expect(
    attachmentLabel([{ url: `${media}/a`, kind: "image", mime: "image/gif" }]),
  ).toBe("GIF");
  expect(attachmentLabel([{ url: `${media}/a.png`, kind: "image" }])).toBe(
    "Image",
  );
  expect(attachmentLabel([{ url: `${media}/a.mp4`, kind: "video" }])).toBe(
    "Video",
  );
  expect(
    attachmentLabel([
      { url: `${media}/a.m4a`, kind: "audio", voiceNote: true },
    ]),
  ).toBe("Voice message");
  expect(attachmentLabel([{ url: `${media}/a.m4a`, kind: "audio" }])).toBe(
    "Audio",
  );
  expect(
    attachmentLabel([{ url: `${media}/a`, kind: "file", name: "report.pdf" }]),
  ).toBe("report.pdf");
  expect(attachmentLabel([{ url: `${media}/a`, kind: "file" }])).toBe("File");
  // A sender-supplied name is one bounded line, without bidi overrides.
  expect(
    attachmentLabel([
      { url: `${media}/a`, kind: "file", name: "invoice\u202Efdp.exe\nnext" },
    ]),
  ).toBe("invoice fdp.exe next");
  expect(
    attachmentLabel([{ url: `${media}/a`, kind: "file", name: "\u202E\n" }]),
  ).toBe("File");
  expect(
    attachmentLabel([
      { url: `${media}/a.png`, kind: "image" },
      { url: `${media}/b.gif`, kind: "image" },
      { url: `${media}/c.png`, kind: "image" },
    ]),
  ).toBe("3 images");
  expect(
    attachmentLabel([
      { url: `${media}/a.png`, kind: "image" },
      { url: `${media}/b`, kind: "file", name: "notes.txt" },
    ]),
  ).toBe("2 attachments");
});
