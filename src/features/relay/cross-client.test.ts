import { describe, expect, it, vi } from "vitest";
import { createMessages } from "./messages";
import { createOutbox, type OutboxStorage } from "./outbox";
import type { EventData } from "./events";
import { foldMessages } from "./fold";
import { MessageProjection } from "./message-projection";
import { createRelayProfiler } from "./profiling";
import { shareMessageRows } from "./row-identity";
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
    kinds: [9, 40003, 5],
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

  it("fold preserves spoiler delimiters", () => {
    const row = fold(message(alice, channel, "Before ||secret|| after", 10));

    expect(row?.content).toBe("Before ||secret|| after");
    expect(row?.attachments).toEqual([]);
  });

  it("emits original imeta tags on text edits so old clients retain attachments", async () => {
    const original = message(alice, channel, `Original ${imageUrl}`, 10, [
      imageIMeta(),
    ]);
    const outbox = localOutbox(alice.pubkey);
    await outbox.ready();
    const messages = createMessages(
      outbox,
      alice.pubkey,
      (id) => (id === original.id ? original : undefined),
      () => [],
      () => {},
    );

    const editId = messages.edit(original.id, "Edited text", original.id);
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

it.each([9, 40002])(
  "kind %s preserves edited media through incremental text edits and deletion",
  (kind) => {
    const original = signed(alice, {
      kind,
      content: "Original",
      created_at: 10,
      tags: [["h", channel], fileIMeta()],
    });
    const media = signed(alice, {
      kind: 40003,
      content: "Current",
      created_at: 11,
      tags: [["h", channel], ["e", original.id], imageIMeta()],
    });
    const text = signed(alice, {
      kind: 40003,
      content: "Latest caption",
      created_at: 12,
      tags: [
        ["h", channel],
        ["e", original.id],
      ],
    });
    const spoof = signed(keypair(), {
      kind: 40003,
      content: "Spoof",
      created_at: 13,
      tags: [["h", channel], ["e", original.id], fileIMeta()],
    });
    const projection = new MessageProjection(
      channel,
      relay.pubkey,
      createRelayProfiler(),
    );
    const before = projection.reconcile([original, media], []);
    const after = projection.reconcile([original, media, text, spoof], []);
    expect(after[0]).toMatchObject({
      content: "Latest caption",
      attachmentSourceId: media.id,
    });
    expect(after[0]?.attachments).toEqual(before[0]?.attachments);
    expect(after).toEqual(
      foldMessages(channel, relay.pubkey, [original, media, text, spoof]),
    );
    const deleted = signed(alice, {
      kind: 5,
      content: "",
      created_at: 14,
      tags: [
        ["h", channel],
        ["e", media.id],
      ],
    });
    const restored = projection.reconcile(
      [original, media, text, spoof, deleted],
      [],
    );
    expect(restored[0]?.attachmentSourceId).toBeUndefined();
    expect(restored[0]?.attachments.map(({ url }) => url)).toEqual([fileUrl]);
  },
);

it("retains changed attachment provenance even when presentation is identical", () => {
  const original = message(alice, channel, "Caption", 10, [imageIMeta()]);
  const edit = signed(alice, {
    kind: 40003,
    content: "Caption",
    created_at: 11,
    tags: [["e", original.id], imageIMeta()],
  });
  const second = signed(alice, { ...edit, created_at: 12 });
  const before = foldMessages(channel, relay.pubkey, [original, edit]);
  const next = foldMessages(channel, relay.pubkey, [original, edit, second]);
  expect(shareMessageRows(before, next)[0]?.attachmentSourceId).toBe(second.id);
});

it("rejects unavailable or unrelated attachment sources without queuing an edit", () => {
  const original = message(alice, channel, "Caption", 10, [fileIMeta()]);
  const source = (tags: string[][], author = alice, kind = 40003) =>
    signed(author, {
      kind,
      content: "Edited",
      created_at: 11,
      tags,
    });
  const invalid = [
    source([["e", original.id], imageIMeta()], keypair()),
    source([["e", "f".repeat(64)], imageIMeta()]),
    source([["e", original.id], ["h", "elsewhere"], imageIMeta()]),
    source([["e", original.id]]),
    source([["e", original.id], imageIMeta()], alice, 7),
  ];
  const outbox = localOutbox(alice.pubkey);
  const messages = createMessages(
    outbox,
    alice.pubkey,
    (id) => [original, ...invalid].find((event) => event.id === id),
    () => [],
    () => {},
  );
  for (const id of ["missing", ...invalid.map((event) => event.id)])
    expect(() => messages.edit(original.id, "New caption", id)).toThrow(
      /Reload the message/,
    );
  expect(outbox.snapshot()).toEqual([]);
});

it("edits and removes attributed messages using trusted relay signing authority only", async () => {
  const attributed = signed(relay, {
    kind: 9,
    content: "Original",
    created_at: 20,
    tags: [["h", channel], ["actor", alice.pubkey], fileIMeta()],
  });
  const media = signed(alice, {
    kind: 40003,
    content: "Media",
    created_at: 21,
    tags: [["h", channel], ["e", attributed.id], imageIMeta()],
  });
  const events = [attributed, media];
  const outbox = localOutbox(alice.pubkey);
  await outbox.ready();
  const command = (authority?: string) =>
    createMessages(
      outbox,
      alice.pubkey,
      (id) => events.find((event) => event.id === id),
      () => [],
      () => {},
      () => true,
      undefined,
      undefined,
      authority,
    );
  expect(
    foldMessages(channel, relay.pubkey, events, {
      signingAuthority: relay.pubkey,
    })[0],
  ).toMatchObject({
    authorId: alice.pubkey,
    attachmentSourceId: media.id,
  });
  for (const authority of [undefined, keypair().pubkey]) {
    expect(() =>
      command(authority).edit(attributed.id, "Next", media.id),
    ).toThrow(/Only your own/);
    expect(() => command(authority).remove([attributed.id])).toThrow(
      /Only your own/,
    );
  }
  const trusted = command(relay.pubkey);
  const editId = trusted.edit(attributed.id, "Next", media.id);
  const edit = outbox
    .snapshot()
    .find((entry) => entry.event.id === editId)?.event;
  expect(edit?.tags).toContainEqual(imageIMeta());
  const removeId = trusted.remove([attributed.id]);
  const deletion = outbox
    .snapshot()
    .find((entry) => entry.event.id === removeId)?.event;
  expect(deletion?.tags).toContainEqual(["e", attributed.id]);
  expect(
    foldMessages(
      channel,
      relay.pubkey,
      [
        attributed,
        media,
        ...(edit ? [edit] : []),
        ...(deletion ? [deletion] : []),
      ],
      {
        signingAuthority: relay.pubkey,
      },
    ),
  ).toEqual([]);
  const untrusted = signed(keypair(), {
    kind: 9,
    content: "Spoof",
    tags: [
      ["h", channel],
      ["actor", alice.pubkey],
    ],
  });
  events.push(untrusted);
  expect(() => trusted.edit(untrusted.id, "No", untrusted.id)).toThrow(
    /Only your own/,
  );
  expect(() => trusted.remove([untrusted.id])).toThrow(/Only your own/);
});
