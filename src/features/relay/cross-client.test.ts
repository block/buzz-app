import { describe, expect, it, vi } from "vitest";
import { createMessages } from "./messages";
import { createOutbox, type OutboxStorage } from "./outbox";
import type { EventData } from "./events";
import { foldMessages } from "./fold";
import { keypair, message, signed } from "./testing";

const relay = keypair(),
  alice = keypair();
const channel = "compat";
const imageUrl = "https://relay.test/media/photo.png";
const fileUrl = "https://relay.test/media/report.pdf";
const imageIMeta = () => [
  "imeta",
  `url ${imageUrl}`,
  "m image/png",
  "dim 640x480",
];
const fileIMeta = () => [
  "imeta",
  `url ${fileUrl}`,
  "m application/pdf",
  "size 1234",
];

function memoryStorage(): OutboxStorage {
  return { load: () => [], save: () => {} };
}

function localOutbox(viewer: string) {
  const writer = {
    sign: vi.fn(async (event) => signed(alice, event)),
    publish: vi.fn(async () => {}),
    kinds: [9, 40003],
  };
  return createOutbox(viewer, writer, memoryStorage()).outbox;
}

function fold(events: EventData | readonly EventData[]) {
  return foldMessages(
    channel,
    relay.pubkey,
    Array.isArray(events) ? events : [events],
  )[0];
}

describe("cross-client rich content compatibility", () => {
  it.each([
    {
      name: "old Markdown image",
      content: `Before ![photo](${imageUrl}) after`,
      tags: [],
      expectedContent: "Before  after",
      expectedAttachments: [{ url: imageUrl, kind: "image" }],
    },
    {
      name: "new imeta image",
      content: "Before attachment after",
      tags: [imageIMeta()],
      expectedContent: "Before attachment after",
      expectedAttachments: [
        {
          url: imageUrl,
          kind: "image",
          mime: "image/png",
          name: "photo.png",
          dimensions: { width: 640, height: 480 },
        },
      ],
    },
    {
      name: "new imeta file with attachment link label",
      content: `Before [Quarterly Report](${fileUrl}) after`,
      tags: [fileIMeta()],
      expectedContent: "Before  after",
      expectedAttachments: [
        {
          url: fileUrl,
          kind: "file",
          mime: "application/pdf",
          size: 1234,
          name: "Quarterly Report",
        },
      ],
    },
  ])(
    "folds representative $name content",
    ({ content, tags, expectedContent, expectedAttachments }) => {
      const row = fold(message(alice, channel, content, 10, tags));
      expect(row?.content).toBe(expectedContent);
      expect(row?.attachments).toEqual(expectedAttachments);
    },
  );

  it("uses the latest authorized edit imeta as the attachment metadata source", () => {
    const original = message(
      alice,
      channel,
      `Original [Report](${fileUrl})`,
      10,
      [fileIMeta()],
    );
    const edit = signed(alice, {
      kind: 40003,
      content: `Edited ![photo](${imageUrl})`,
      created_at: 11,
      tags: [["h", channel], ["e", original.id], imageIMeta()],
    });
    const spoofedLaterEdit = signed(keypair(), {
      kind: 40003,
      content: "Spoofed",
      created_at: 12,
      tags: [["h", channel], ["e", original.id], fileIMeta()],
    });

    expect(fold([original, edit, spoofedLaterEdit])).toMatchObject({
      content: "Edited",
      edited: true,
      attachments: [
        {
          url: imageUrl,
          kind: "image",
          mime: "image/png",
          name: "photo.png",
          dimensions: { width: 640, height: 480 },
        },
      ],
    });
  });

  it("preserves original imeta attachments on text-only edits without imeta", () => {
    const original = message(alice, channel, "Original attachment", 10, [
      imageIMeta(),
    ]);
    const edit = signed(alice, {
      kind: 40003,
      content: "Edited text",
      created_at: 11,
      tags: [
        ["h", channel],
        ["e", original.id],
      ],
    });

    expect(fold([original, edit])).toMatchObject({
      content: "Edited text",
      edited: true,
      attachments: [
        {
          url: imageUrl,
          kind: "image",
          mime: "image/png",
          name: "photo.png",
          dimensions: { width: 640, height: 480 },
        },
      ],
    });
  });

  it("admits kind 40008 diff rows as raw patch content with file metadata", () => {
    const content =
      "@@ -1 +1 @@\n-![old](https://relay.test/old.png)\n+new text\n";
    const diff = signed(alice, {
      kind: 40008,
      content,
      created_at: 10,
      tags: [
        ["h", channel],
        ["file", "src/example.ts"],
        ["description", "Update example"],
      ],
    });

    expect(foldMessages(channel, relay.pubkey, [diff])).toEqual([
      expect.objectContaining({
        id: diff.id,
        content,
        attachments: [],
        diff: expect.objectContaining({
          filePath: "src/example.ts",
          description: "Update example",
          truncated: false,
        }),
      }),
    ]);
  });

  it("renders spoiler syntax as ordinary literal text", () => {
    const row = fold(message(alice, channel, "Before ||secret|| after", 10));

    expect(row?.content).toBe("Before ||secret|| after");
    expect(row?.attachments).toEqual([]);
  });

  it("emits original imeta tags on text edits so old clients retain attachments", () => {
    const original = message(alice, channel, `Original ${imageUrl}`, 10, [
      imageIMeta(),
    ]);
    const outbox = localOutbox(alice.pubkey);
    const messages = createMessages(
      outbox,
      alice.pubkey,
      (id) => (id === original.id ? original : undefined),
      () => [],
      () => {},
    );

    const editId = messages.edit(original.id, "Edited text");
    const edit = outbox
      .snapshot()
      .find((item) => item.event.id === editId)?.event;

    expect(edit?.tags).toEqual(
      expect.arrayContaining([
        ["h", channel],
        ["e", original.id],
        imageIMeta(),
      ]),
    );
  });
});
