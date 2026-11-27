// @vitest-environment jsdom
import { expect, it } from "vitest";
import {
  buzzCopyDocument,
  composerClipboard,
  externalLinkMarkdown,
  pastedFiles,
} from "./composer-clipboard";
import { composerSchema } from "./composer-document";
import { spoilerDelimiter } from "./selection-copy";

const { doc, paragraph, bullet_list, list_item, token } = composerSchema.nodes;

it("copies heading levels to documents and keeps their Markdown prefix in chat", () => {
  const heading = composerSchema.nodes.heading.create(
    { level: 2 },
    composerSchema.text("Heading"),
  );
  const original = doc.create(null, heading);
  const copied = composerClipboard(original, document, "document");
  expect(copied.text).toBe("## Heading");
  expect(buzzCopyDocument(copied.html, "document")?.eq(original)).toBe(true);
  const chat = buzzCopyDocument(copied.html);
  expect(chat?.firstChild?.type.name).toBe("paragraph");
  expect(chat?.textContent).toBe(copied.text);
});

it("copies aligned document tables with exact Markdown and pastes source in chat", () => {
  const source = "| Value |\n| ---: |\n| `a\\|b` |";
  const table = composerSchema.nodes.markdown_table.create({ source });
  const original = doc.create(null, table);
  const copied = composerClipboard(original, document, "document");
  expect(copied.text).toBe(source);
  expect(buzzCopyDocument(copied.html, "document")?.eq(original)).toBe(true);
  const chat = buzzCopyDocument(copied.html);
  expect(chat?.firstChild?.type).toBe(paragraph);
  expect(chat?.textContent).toBe(source);
});

it("copies plain text and unlinked tokens as text and round-trips clipboard HTML", () => {
  const source = "<img src=x onerror=alert(1)> & text";
  const copied = composerClipboard(
    doc.create(
      null,
      paragraph.create(null, [
        composerSchema.text("before "),
        token.create({ source }),
        composerSchema.text(" after"),
      ]),
    ),
    document,
  );
  const html = new DOMParser().parseFromString(copied.html, "text/html");
  expect(html.body.textContent).toBe(`before ${source} after`);
  expect(html.querySelector("img")).toBeNull();
  expect(copied.text).toBe(`before ${source} after`);
  expect(buzzCopyDocument(copied.html)?.toJSON()).toEqual({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: `before ${source} after` }],
      },
    ],
  });
});

it("reads its own blocks and marks back as nodes, with anchors and breaks as text", () => {
  const bold = [composerSchema.marks.bold.create()];
  const copied = composerClipboard(
    doc.create(null, [
      paragraph.create(null, [
        composerSchema.text("a"),
        composerSchema.text("\nb", bold),
      ]),
      bullet_list.create(
        null,
        list_item.create(
          null,
          paragraph.create(null, [
            composerSchema.text("see "),
            token.create({ source: "[docs](https://example.com/)" }),
          ]),
        ),
      ),
    ]),
    document,
  );
  expect(copied.html).toBe(
    '<div data-buzz-copy="composer"><p>a<strong><br>b</strong></p><ul><li><p>see <a href="https://example.com/">docs</a></p></li></ul></div>',
  );
  expect(buzzCopyDocument(copied.html)?.toJSON()).toEqual({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "\nb", marks: [{ type: "bold" }] },
        ],
      },
      {
        type: "bullet_list",
        attrs: { spread: false },
        content: [
          {
            type: "list_item",
            attrs: { spread: false },
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "see [docs](https://example.com/)" },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  expect(buzzCopyDocument("<p>other</p>")).toBeUndefined();
});

it("keeps a spoiler a mark in its HTML and reads it back", () => {
  const copied = composerClipboard(
    doc.create(
      null,
      paragraph.create(null, [
        composerSchema.text("a "),
        composerSchema.text("secret", [composerSchema.marks.spoiler.create()]),
      ]),
    ),
    document,
  );
  expect(copied).toEqual({
    text: "a ||secret||",
    html: `<div data-buzz-copy="composer"><p>a <span data-spoiler="">${spoilerDelimiter}secret${spoilerDelimiter}</span></p></div>`,
  });
  expect(buzzCopyDocument(copied.html)?.toJSON()).toEqual({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "a " },
          { type: "text", text: "secret", marks: [{ type: "spoiler" }] },
        ],
      },
    ],
  });
});

it("labels a linked spoiler without its delimiters", () => {
  const href = "https://example.com/";
  const copied = composerClipboard(
    doc.create(
      null,
      paragraph.create(null, [
        composerSchema.text("a "),
        composerSchema.text("secret", [
          composerSchema.marks.link.create({ href }),
          composerSchema.marks.spoiler.create(),
        ]),
      ]),
    ),
    document,
  );
  expect(copied.html).toBe(
    `<div data-buzz-copy="composer"><p>a <a href="${href}"><span data-spoiler="">${spoilerDelimiter}secret${spoilerDelimiter}</span></a></p></div>`,
  );
  // The link's label is the spoiler's content; the mark itself does not
  // survive the anchor, as before.
  expect(buzzCopyDocument(copied.html)?.toJSON()).toEqual({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: `a [secret](${href})` }],
      },
    ],
  });
});

it("reads crafted HTML whose anchors have no text as an empty paste, not an error", () => {
  expect(
    buzzCopyDocument(
      '<div data-buzz-copy="composer"><a href="javascript:x"></a><a href="https://example.com/"></a></div>',
    )?.toJSON(),
  ).toEqual({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "https://example.com/" }],
      },
    ],
  });
});

it("pastes text whose picture rides beside it, and attaches every other file", () => {
  const paste = (
    flavors: { html?: string | undefined; plain?: string | undefined },
    ...files: File[]
  ) =>
    pastedFiles({
      items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
      getData: (type: string) =>
        (type === "text/html" ? flavors.html : flavors.plain) ?? "",
    } as unknown as DataTransfer);
  const picture = new File(["png"], "image.png", { type: "image/png" });
  const pdf = new File(["pdf"], "notes.pdf", { type: "application/pdf" });
  // Copied office cells: their text, their HTML and a picture of them.
  const cells = { html: "<table><tr><td>Q3</td></tr></table>", plain: "Q3" };
  expect(paste(cells, picture)).toEqual([]);
  // Without plain text no text path can insert, so the picture is the paste.
  for (const plain of [undefined, "", " \n"])
    expect(paste({ ...cells, plain }, picture)).toEqual([picture]);
  expect(
    paste({ html: "<span><style>.x{}</style></span>", plain: "" }, picture),
  ).toEqual([picture]);
  // A screenshot, a copied image and copied files stay attachments.
  expect(paste({ plain: "image.png" }, picture)).toEqual([picture]);
  expect(
    paste(
      { html: '<img src="https://example.com/a.png">', plain: "a" },
      picture,
    ),
  ).toEqual([picture]);
  expect(paste({ html: "<p>notes.pdf</p>", plain: "notes.pdf" }, pdf)).toEqual([
    pdf,
  ]);
  expect(paste(cells, picture, pdf)).toEqual([picture, pdf]);
  expect(paste(cells)).toEqual([]);
  expect(pastedFiles(null)).toEqual([]);
});

it("keeps default chat clipboard output when document list metadata is present", () => {
  const tree = doc.create(null, [
    paragraph.create(null, [
      composerSchema.text("First"),
      composerSchema.nodes.hard_break.create(),
      composerSchema.text("Second"),
    ]),
    bullet_list.create({ spread: true }, [
      list_item.create(
        null,
        paragraph.create(null, composerSchema.text("One")),
      ),
      list_item.create(
        null,
        paragraph.create(null, composerSchema.text("Two")),
      ),
    ]),
  ]);
  const chat = composerClipboard(tree, document);
  expect(chat.text).toBe("First\nSecond\n\n- One\n- Two");
  expect(chat.html).toBe(
    '<div data-buzz-copy="composer"><p>First<br>Second</p><ul><li><p>One</p></li><li><p>Two</p></li></ul></div>',
  );
  const copied = composerClipboard(tree, document, "document");
  const imported = buzzCopyDocument(copied.html);
  expect(imported?.lastChild?.attrs.spread).toBe(false);
});

it.each(["chat", "document"] as const)(
  "copies namesake chips as authored text in %s mode",
  (mode) => {
    const chips = ["a", "b"].flatMap((key, index) => [
      ...(index ? [composerSchema.text(" ")] : []),
      token.create({
        source: "@Honey",
        recipient: { pubkey: key.repeat(64), name: "Honey" },
      }),
    ]);
    const copied = composerClipboard(
      doc.create(null, paragraph.create(null, chips)),
      document,
      mode,
    );
    expect(copied.text).toBe("@Honey @Honey");
    // HTML retains identity destinations for paste; plain text has no send-only keys.
    expect(copied.html.match(/<a /g)).toHaveLength(2);
  },
);
// `data-copy-skip` marks chrome in the live timeline only. Any page can write
// it into clipboard HTML, where it must not make a paste drop text.
it("keeps pasted text that carries the timeline's copy-skip marker", () => {
  expect(
    buzzCopyDocument(
      '<div data-buzz-copy="timeline"><p>Pay <span data-copy-skip>Alice, not </span>Mallory</p><p data-copy-skip>Thanks</p></div>',
    )?.toJSON(),
  ).toEqual({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Pay Alice, not Mallory" }],
      },
      // Timeline paragraphs paste a blank line apart.
      { type: "paragraph" },
      { type: "paragraph", content: [{ type: "text", text: "Thanks" }] },
    ],
  });
});

it.each([
  [
    "Chinese inline link",
    "请阅读文档了解详情",
    '请阅读<a href="https://example.com">文档</a>了解详情',
    "请阅读[文档](https://example.com/)了解详情",
  ],
  [
    "Japanese prose with kana, kanji and prolonged sound mark",
    "ユーザーガイドとドキュメントを確認してください",
    '<a href="https://a.example">ユーザーガイド</a>と<a href="https://b.example">ドキュメント</a>を確認してください',
    "[ユーザーガイド](https://a.example/)と[ドキュメント](https://b.example/)を確認してください",
  ],
  [
    "Korean link touching particle",
    "문서를 읽어주세요",
    '<a href="https://example.com">문서</a>를 읽어주세요',
    "[문서](https://example.com/)를 읽어주세요",
  ],
  [
    "intra-word English infix",
    "Check foobarbaz now",
    'Check foo<a href="https://example.com">bar</a>baz now',
    "Check foo[bar](https://example.com/)baz now",
  ],
  [
    "intra-word English prefix and suffix",
    "supernova is unlinked",
    '<a href="https://a.example">super</a>nova is un<a href="https://b.example">linked</a>',
    "[super](https://a.example/)nova is un[linked](https://b.example/)",
  ],
  [
    "adjacent links inside one word",
    "foobar",
    '<a href="https://a.example">foo</a><a href="https://b.example">bar</a>',
    "[foo](https://a.example/)[bar](https://b.example/)",
  ],
  [
    "multi-word link starting and ending mid-word",
    "prefoo barpost",
    'pre<a href="https://example.com">foo bar</a>post',
    "pre[foo bar](https://example.com/)post",
  ],
  [
    "anchor with leading and trailing whitespace",
    "Read guide now",
    'Read<a href="https://example.com"> guide </a>now',
    "Read [guide](https://example.com/) now",
  ],
])(
  "preserves external links without whitespace boundaries: %s",
  (_, plain, html, expected) => {
    expect(externalLinkMarkdown(html, plain)).toBe(expected);
  },
);

it("preserves CJK and intra-word links with Slack and Codex noise", () => {
  const slackPlain = [
    "[2:43 PM]:robot_face: 请阅读文档，然后再次查看文档。",
    "• 查看 PR #296 的修改与unlinked说明",
  ].join("\n");
  const slackHtml = [
    '<a href="https://example.slack.com/p1">2:43 PM</a>',
    '<img alt="🤖" data-stringify-emoji=":robot_face:"> ',
    '请阅读文档，然后再次查看<a href="https://example.com/doc">文档</a>。',
    '<ul><li>查看<a href="https://github.com/org/repo/pull/296">PR #296</a>的修改与un<a href="https://example.com/note">linked</a>说明</li></ul>',
  ].join("");
  expect(externalLinkMarkdown(slackHtml, slackPlain)).toBe(
    [
      "[[2:43 PM](https://example.slack.com/p1)]:robot_face: 请阅读文档，然后再次查看[文档](https://example.com/doc)。",
      "• 查看 [PR #296](https://github.com/org/repo/pull/296) 的修改与un[linked](https://example.com/note)说明",
    ].join("\n"),
  );

  const codexPlain = [
    "```ts",
    "run()",
    "```",
    "复制请先查看`src/parser.ts`并阅读foobarbaz了解详情。",
  ].join("\n");
  const codexHtml = [
    '<div><div><span>ts</span><button type="button">Copy</button></div><pre><code>run()</code></pre></div>',
    '<p><button type="button">复制</button>请先查看<a href="https://example.com/parser"><code>src/parser.ts</code><svg><title>open</title></svg></a>并阅读foo<a href="https://example.com/bar">bar</a>baz了解详情。</p>',
  ].join("");
  expect(externalLinkMarkdown(codexHtml, codexPlain)).toBe(
    [
      "```ts",
      "run()",
      "```",
      "复制请先查看[`src/parser.ts`](https://example.com/parser)并阅读foo[bar](https://example.com/bar)baz了解详情。",
    ].join("\n"),
  );
});

it("keeps mismatch, hidden and unsafe-scheme guards for CJK and intra-word links", () => {
  expect(
    externalLinkMarkdown(
      '打开<a href="https://evil.example">文档</a>',
      "点击文档",
    ),
  ).toBeUndefined();
  expect(
    externalLinkMarkdown(
      'pay<a href="https://evil.example">bar</a>baz',
      "clickbarbaz",
    ),
  ).toBeUndefined();
  expect(
    externalLinkMarkdown(
      'Pay <a href="https://evil.example">Al</a><a href="https://evil.example/2">ice</a>',
      "Click Alice",
    ),
  ).toBeUndefined();
  expect(
    externalLinkMarkdown(
      'foo<span hidden><a href="https://evil.example">bar</a></span>barbaz',
      "foobarbaz",
    ),
  ).toBeUndefined();
  expect(
    externalLinkMarkdown(
      '<noscript><a href="https://evil.example">guide</a></noscript>guide',
      "guide",
    ),
  ).toBeUndefined();
  expect(
    externalLinkMarkdown(
      'foo<a href="javascript:alert(1)">bad</a><a href="https://safe.example">good</a>baz',
      "foobadgoodbaz",
    ),
  ).toBe("foobad[good](https://safe.example/)baz");
});

it("keeps full bare URLs and bare host paths intact when HTML links only the host", () => {
  expect(
    externalLinkMarkdown(
      '<a href="https://example.com/docs">example.com</a>',
      "https://example.com/docs",
    ),
  ).toBeUndefined();
  expect(
    externalLinkMarkdown(
      'Check <a href="https://example.com/docs">example.com</a> and <a href="https://example.com/guide">guide</a>',
      "Check https://example.com/docs and guide",
    ),
  ).toBe(
    "Check https://example.com/docs and [guide](https://example.com/guide)",
  );
  expect(
    externalLinkMarkdown(
      'Check <a href="https://example.com/docs">example.com</a> and <a href="https://example.com/guide">guide</a>',
      "Check example.com/docs and guide",
    ),
  ).toBe("Check example.com/docs and [guide](https://example.com/guide)");
  expect(
    externalLinkMarkdown(
      'Check <a href="https://example.com/docs">example.com</a>',
      "Check example.com",
    ),
  ).toBe("Check [example.com](https://example.com/docs)");
});

it("skips external links whose labels align ambiguously across extra UI text", () => {
  // Extra linked UI chrome before matching prose with the same label.
  expect(
    externalLinkMarkdown(
      '<p>Run tests:</p><div><a href="https://ui.example/edit">Edit</a> <span>View</span></div><p>Edit the file and save</p>',
      "Run tests:\nEdit the file and save",
    ),
  ).toBeUndefined();
  // Extra linked UI text whose adjacent token also matches a prefix of the prose.
  expect(
    externalLinkMarkdown(
      '<div><a href="https://ui.example/guide">guide</a> and</div><p>guide and notes</p>',
      "guide and notes",
    ),
  ).toBeUndefined();
  // Ambiguous middle gap leaves the repeated label unlinked while keeping unambiguous links.
  expect(
    externalLinkMarkdown(
      'Read: <span>UI</span> <a href="https://ui.example/guide">guide</a> <span>bar</span> guide and <a href="https://example.com/notes">notes</a> details',
      "Read: guide and notes details",
    ),
  ).toBe("Read: guide and [notes](https://example.com/notes) details");
  // Ambiguous duplicate on the plain side leaves both occurrences unlinked.
  expect(
    externalLinkMarkdown(
      'Read: <a href="https://example.com/guide">guide</a> and save',
      "Read: extra guide foo guide bar and save",
    ),
  ).toBeUndefined();
});
