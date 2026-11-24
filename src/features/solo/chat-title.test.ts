import { expect, it } from "vitest";
import { isStartingChatTitle, startingChatTitle } from "./chat-title";
import { mentionDraft } from "../messages/mention-draft";
import { typedDraft } from "../messages/composer-testing";

const link = `buzz://message?channel=design&id=${"c".repeat(64)}`;

it("uses readable channel labels before truncating the title", () => {
  expect(
    startingChatTitle(
      "what is this about [\\#design-and-research-work](buzz://channel/b17e217e-1234-4567-8901-123456789abc)",
    ),
  ).toBe("what is this about #design-and-research-work");
  expect(
    startingChatTitle(
      `Read [guide](https://example.com/${"x".repeat(120)}) then discuss`,
    ),
  ).toBe("Read guide then discuss");
});

it("reads escaped and formatted labels across multiple links", () => {
  expect(
    startingChatTitle(
      "Compare [**A** \\[one\\]](https://example.com/a) with [`B` &amp; C](https://example.com/b)",
    ),
  ).toBe("Compare A [one] with B & C");
  expect(
    startingChatTitle("Read [the guide][ref]\n\n[ref]: https://example.com"),
  ).toBe("Read the guide [ref]: https://example.com");
});

it("preserves code, malformed links and unrelated Markdown source", () => {
  for (const text of [
    "Keep `[label](https://example.com)` literal",
    "Keep [label](unfinished",
    "Keep **bold** and literal \\# text",
  ])
    expect(startingChatTitle(text)).toBe(text);
});

it("truncates readable labels at 80 Unicode code points", () => {
  expect(startingChatTitle(`[${"🐝".repeat(81)}](https://example.com)`)).toBe(
    "🐝".repeat(80),
  );
});

it("titles a linked chat from the prompt after its leading source link", () => {
  expect(startingChatTitle(`${link} Investigate this failure`)).toBe(
    "Investigate this failure",
  );
  expect(startingChatTitle(`${link}\n${link} Compare both`)).toBe(
    "Compare both",
  );
});

it("never titles a link-only prompt with the link, but keeps later links", () => {
  expect(startingChatTitle("buzz://channel/design")).toBe("Chat");
  expect(
    startingChatTitle({
      text: `@Scout ${link}`,
      recipients: [{ pubkey: "a".repeat(64), name: "Scout", start: 0, end: 6 }],
    }),
  ).toBe("Chat");
  expect(startingChatTitle("Look at buzz://channel/design")).toBe(
    "Look at buzz://channel/design",
  );
});

it("drops leading namesake tags with their full-key qualifiers", () => {
  const a = { pubkey: "a".repeat(64), name: "Jitter", start: 0, end: 7 };
  const b = { pubkey: "b".repeat(64), name: "Jitter", start: 8, end: 15 };
  const draft = typedDraft(
    mentionDraft({ text: "@Jitter @Jitter fix the build", recipients: [a, b] }),
  );
  expect(startingChatTitle(draft)).toBe("fix the build");
});

it("titles a message that is only media by what it sent", () => {
  const media = `https://relay.example/media/${"a".repeat(64)}`;
  const agent = [{ pubkey: "a".repeat(64), name: "Scout", start: 0, end: 6 }];
  const tagged = { text: "@Scout ", recipients: agent };
  const sent = (...kinds: ("image" | "video" | "audio" | "file")[]) =>
    kinds.map((kind) => ({ kind }));
  // An upload waits beside the draft; only its kind is known.
  expect(startingChatTitle(tagged, sent("video"))).toBe("Video");
  expect(startingChatTitle(tagged, sent("image"))).toBe("Image");
  expect(startingChatTitle(tagged, sent("file"))).toBe("Attachment");
  expect(startingChatTitle(tagged, sent("image", "image"))).toBe("2 images");
  expect(startingChatTitle(tagged, sent("image", "video", "file"))).toBe(
    "3 attachments",
  );
  expect(
    startingChatTitle({ ...tagged, gifs: ["![wave](https://gif.example/1)"] }),
  ).toBe("Image");
  // A sent message carries its media as embeds and attachment links.
  expect(startingChatTitle(`![video](${media}.mp4)`)).toBe("Video");
  expect(startingChatTitle(`![a](${media}.png)\n![b](${media}.jpg)`)).toBe(
    "2 images",
  );
  expect(
    startingChatTitle(`[notes.txt](<${media}.txt>)`, [
      { kind: "file", url: `${media}.txt` },
    ]),
  ).toBe("Attachment");
});

it("titles text sent with media by the text alone", () => {
  const media = `https://relay.example/media/${"a".repeat(64)}`;
  expect(startingChatTitle("See attached", [{ kind: "video" }])).toBe(
    "See attached",
  );
  expect(
    startingChatTitle(
      `What is this?\n\n![shot.png](<${media}.png>)\n\n[notes.txt](<${media}.txt>)`,
      [
        { kind: "image", url: `${media}.png` },
        { kind: "file", url: `${media}.txt` },
      ],
    ),
  ).toBe("What is this?");
});

it("titles a message that is only web links by their site, never the address", () => {
  expect(startingChatTitle("https://www.example.com/a/b?c=d#e")).toBe(
    "Link to example.com",
  );
  expect(startingChatTitle("<https://example.com/a>")).toBe(
    "Link to example.com",
  );
  expect(
    startingChatTitle("[https://example.com/a](https://example.com/a)"),
  ).toBe("Link to example.com");
  expect(startingChatTitle("https://a.example/1\nhttps://b.example/2")).toBe(
    "2 links",
  );
  // A link the author labelled, or wrote about, already reads as a title.
  expect(startingChatTitle("[Release notes](https://example.com/a)")).toBe(
    "Release notes",
  );
  expect(startingChatTitle("Summarize https://example.com/a")).toBe(
    "Summarize https://example.com/a",
  );
});

it("recognizes the starting title other and earlier clients stored for a message", () => {
  const url = `https://relay.example/media/${"a".repeat(64)}.mp4`;
  const video = [{ kind: "video" as const, url }];
  // The message's source from its start, cut at 80 characters.
  const literal = (content: string) =>
    [...content.replace(/\s+/g, " ")].slice(0, 80).join("");
  for (const content of [
    `![video](${url})`,
    `Look at this\n![video](${url})`,
  ]) {
    expect(literal(content)).not.toContain(")");
    expect(isStartingChatTitle(literal(content), content, video)).toBe(true);
    expect(
      isStartingChatTitle(startingChatTitle(content, video), content, video),
    ).toBe(true);
  }
  const link = `https://example.com/${"x".repeat(120)}`;
  expect(isStartingChatTitle(literal(link), link)).toBe(true);
  expect(isStartingChatTitle("Link to example.com", link)).toBe(true);
  // Before media was described, a chat that sent only media was "Chat".
  expect(isStartingChatTitle("Chat", `![video](${url})`, video)).toBe(true);
  expect(isStartingChatTitle("My clip", `![video](${url})`, video)).toBe(false);
});
