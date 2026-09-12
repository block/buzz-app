import { expect, it } from "vitest";
import { profileMentionParts } from "./profile-mentions";
import { profileTarget } from "../profiles/target";
import type { ChannelMessage } from "../relay/contracts";
const alice = "a".repeat(64),
  mic = "b".repeat(64),
  other = "c".repeat(64);
const profiles = new Map([
  [alice, { name: "Mic Smith" }],
  [mic, { name: "Mic" }],
  [other, { name: "Other" }],
]);
const row: ChannelMessage = {
  id: "row",
  channelId: "channel",
  authorId: alice,
  content: "",
  createdAt: 1,
  mentions: [alice, mic],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
};
const parts = (content: string, patch: Partial<ChannelMessage> = {}) =>
  profileMentionParts({ ...row, content, ...patch }, profiles);
it("binds only tagged exact names, longest first, and preserves every byte", () => {
  const content = "@Mic Smith, (@Mic)! @Other @Missing @Microscopic";
  const result = parts(content);
  expect(result.filter((part) => part.target)).toEqual([
    { text: "@Mic Smith", target: profileTarget(alice) },
    { text: "@Mic", target: profileTarget(mic) },
  ]);
  expect(result.map((part) => part.text).join("")).toBe(content);
});
it.each([
  "`https://example.test @Mic`",
  "`` a ` @Mic ``",
  "```ts\n@Mic\n```",
  "~~~\n@Mic\n~~~",
  "`unfinished @Mic",
  "email@Mic",
  "https://example.test/@Mic",
  "http://example.test/@Mic",
  "[label @Mic](https://example.test)",
  "![alt @Mic](https://example.test)",
  "[@Mic][reference]",
  "\\@Mic",
  "@Mic_foo",
  "@Micé",
])("leaves code/link/non-token context literal: %s", (content) => {
  expect(parts(content)).toEqual([{ text: content }]);
});
it("recognizes prose after a closed code span even when the span contained HTTPS", () => {
  expect(
    parts("`https://example.test @Mic` then @Mic").filter((p) => p.target),
  ).toEqual([{ text: "@Mic", target: profileTarget(mic) }]);
});
it("ambiguous longer labels cannot become shorter clickable prefixes", () => {
  const result = profileMentionParts(
    { ...row, content: "@Mic Smith and @Mic", mentions: [alice, mic, other] },
    new Map([
      [alice, { name: "Mic Smith" }],
      [mic, { name: "Mic" }],
      [other, { name: "Mic Smith" }],
    ]),
  );
  expect(result).toEqual([
    { text: "@Mic Smith and " },
    { text: "@Mic", target: profileTarget(mic) },
  ]);
});
it("does not bind replacement text to original notification recipients", () => {
  expect(parts("@Mic", { edited: true })).toEqual([{ text: "@Mic" }]);
  expect(parts("@Mic", { mentions: [] })).toEqual([{ text: "@Mic" }]);
  expect(profileMentionParts({ ...row, content: "@Mic" }, undefined)).toEqual([
    { text: "@Mic" },
  ]);
});

it("does not bind the short-name prefix of a legacy full-key-qualified namesake", () => {
  const content = `@Mic (${other})`;
  expect(parts(content, { mentions: [mic, other] })).toEqual([
    { text: content },
  ]);
});

it.each([
  "    @Mic",
  "\t@Mic",
  "   \t@Mic",
  "intro\n    @Mic\n\t@Mic",
  '```js\nconst marker = "```";\n@Mic\n```',
  '~~~js\nconst marker = "~~~";\n@Mic\n~~~',
  "````\n```\n@Mic\n````",
  "```\n``` not a closer\n@Mic\n```",
  "```\n    ```\n@Mic\n```",
  "```\n@Mic",
])("keeps indented and entire fenced code literal: %s", (content) => {
  expect(parts(content)).toEqual([{ text: content }]);
});
it.each([
  "    @Mic\n\n@Mic",
  "\t@Mic\n@Mic",
  '```js\nconst marker = "```";\n@Mic\n```\n@Mic',
  "  ~~~txt\n@Mic\n   ~~~~  \n@Mic",
  "```\r\n@Mic\r\n```\r\n@Mic",
])(
  "recognizes prose after block code, never the code inside: %s",
  (content) => {
    const result = parts(content);
    expect(result).toEqual([
      { text: content.slice(0, -4) },
      { text: "@Mic", target: profileTarget(mic) },
    ]);
    expect(result.map((part) => part.text).join("")).toBe(content);
  },
);
