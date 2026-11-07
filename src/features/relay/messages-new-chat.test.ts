import { expect, it, vi } from "vitest";
import { createMessages } from "./messages";
import type { Outbox } from "./outbox";
import type { UploadedAttachment } from "./attachments";
import { OUTBOX_INPUT_MAX_BYTES } from "./budget";

const agent = "b".repeat(64);
const channel = "22222222-2222-4222-8222-222222222222";
const origin = "https://relay.example.org";
const attachment: UploadedAttachment = {
  name: "notes.txt",
  url: `${origin}/media/${"f".repeat(64)}.txt`,
  type: "text/plain",
  size: 5,
  sha256: "f".repeat(64),
};

function fixture(emoji: string[][] = []) {
  const enqueue = vi.fn<Outbox["send"]>(() => "first-event");
  const validate = vi.fn(
    (_channel: string, _recipients: readonly string[]) => {},
  );
  const canWrite = vi.fn(() => true);
  const messages = createMessages(
    { supports: () => true, send: enqueue } as unknown as Outbox,
    "a".repeat(64),
    () => undefined,
    () => emoji,
    validate,
    canWrite,
    origin,
  );
  return { messages, enqueue, validate, canWrite };
}

it.each(["a", "é", "😀"])(
  "accepts the exact UTF-8 event budget and refuses one extra byte (%s)",
  (character) => {
    const f = fixture();
    const template = (content: string) => ({
      kind: 9,
      content,
      tags: [
        ["h", channel],
        ["p", agent],
      ],
    });
    const room =
      OUTBOX_INPUT_MAX_BYTES - Buffer.byteLength(JSON.stringify(template("")));
    const width = Buffer.byteLength(character);
    const content =
      character.repeat(Math.floor(room / width)) + "a".repeat(room % width);
    expect(Buffer.byteLength(JSON.stringify(template(content)))).toBe(
      OUTBOX_INPUT_MAX_BYTES,
    );
    expect(() => f.messages.prepareNewChat(`${content}a`, [agent])).toThrow(
      "Message is empty or too large",
    );
    expect(f.enqueue).not.toHaveBeenCalled();
    const prepared = f.messages.prepareNewChat(content, [agent]);
    prepared.send(channel);
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(template(content));
  },
);

it("captures attachment, emoji, model and effort tags before a new channel exists", () => {
  const emoji = ["emoji", "wave", "https://media.example.org/wave.png"];
  const f = fixture([emoji]);
  const recipients = [agent];
  const files = [attachment];
  const picks = { [agent]: { model: "deep", effort: "high" } };
  const prepared = f.messages.prepareNewChat(
    "Look :wave:",
    recipients,
    files,
    picks,
  );
  expect(f.enqueue).not.toHaveBeenCalled();
  recipients.length = 0;
  files.length = 0;
  picks[agent] = { model: "fast", effort: "low" };
  const recovery = { key: "task", value: "receipt" };
  prepared.send(channel, recovery);
  expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(
    {
      kind: 9,
      content: `Look :wave:\n\n[notes.txt](<${attachment.url}>)`,
      tags: [
        ["h", channel],
        ["p", agent],
        ["model", agent, "deep"],
        ["effort", agent, "high"],
        emoji,
        [
          "imeta",
          `url ${attachment.url}`,
          "m text/plain",
          "size 5",
          `x ${attachment.sha256}`,
          "filename notes.txt",
        ],
      ],
    },
    recovery,
  );
});

it("checks live membership and write access only when the captured message sends", () => {
  const f = fixture();
  const prepared = f.messages.prepareNewChat("A task", [agent]);
  expect(f.validate).not.toHaveBeenCalled();
  expect(f.canWrite).not.toHaveBeenCalled();
  f.validate.mockImplementationOnce(() => {
    throw new Error("Recipient is no longer a member");
  });
  expect(() => prepared.send(channel)).toThrow(
    "Recipient is no longer a member",
  );
  expect(f.enqueue).not.toHaveBeenCalled();
  f.canWrite.mockReturnValue(false);
  expect(() => prepared.send(channel)).toThrow("write access");
  expect(f.enqueue).not.toHaveBeenCalled();
  f.canWrite.mockReturnValue(true);
  prepared.send(channel);
  expect(f.enqueue).toHaveBeenCalledOnce();
  expect(f.validate).toHaveBeenLastCalledWith(channel, [agent]);
  expect(f.canWrite).toHaveBeenLastCalledWith(channel, undefined);
});
