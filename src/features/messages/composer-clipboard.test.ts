// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import {
  buzzCopyDocument,
  composerClipboard,
  fetchPastedImages,
  pastedFiles,
  pastedHtml,
  pastedInlineImages,
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

it("pastes text first: files attach only without text, or when the text is just their names", () => {
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
  // Text that is neither a file's name nor a URL pastes as text.
  expect(
    paste(
      { html: '<img src="https://example.com/a.png">', plain: "a" },
      picture,
    ),
  ).toEqual([]);
  expect(paste({ html: "<p>notes.pdf</p>", plain: "notes.pdf" }, pdf)).toEqual([
    pdf,
  ]);
  expect(paste(cells, picture, pdf)).toEqual([]);
  expect(paste(cells)).toEqual([]);
});
function clipboard(
  names: string[],
  text: string,
  html = "",
  read: string[] = [],
) {
  return {
    items: names.map((name) => ({
      kind: "file",
      getAsFile: () => new File([name], name),
    })),
    types: html ? ["text/plain", "text/html"] : ["text/plain"],
    getData: (type: string) => {
      read.push(type);
      return type === "text/plain" ? text : type === "text/html" ? html : "";
    },
  } as unknown as DataTransfer;
}

it.each<
  [
    shape: string,
    expected: string[],
    names: string[],
    text: string,
    html?: string,
  ]
>([
  ["a picture alone", ["image.png"], ["image.png"], ""],
  ["a picture with blank text", ["image.png"], ["image.png"], " \n\t"],
  [
    "a copied file with its own name",
    ["report.pdf"],
    ["report.pdf"],
    "report.pdf",
  ],
  [
    "copied files with their names",
    ["image.png", "report.pdf"],
    ["image.png", "report.pdf"],
    "image.png\r\nreport.pdf\r",
  ],
  [
    "a picture with its URL and no HTML",
    ["image.png"],
    ["image.png"],
    "https://example.com/media/image.png",
  ],
  [
    "a browser's Copy Image",
    ["image.png"],
    ["image.png"],
    "https://example.com/media/image.png",
    '<meta charset="utf-8"><img src="https://example.com/media/image.png">',
  ],
  [
    "a link-only cell and a picture from Excel",
    [],
    ["image.png"],
    "https://example.com/",
    '<table><tr><td><a href="https://example.com/">https://example.com/</a></td></tr></table>',
  ],
  [
    "text and a picture from Excel",
    [],
    ["image.png"],
    "Q3 revenue\t$4.2M\nQ3 cost\t$3.1M",
  ],
  ["a picture with a different name", [], ["image.png"], "photo.png"],
  [
    "a picture with a URL inside text",
    [],
    ["image.png"],
    "See https://example.com/",
  ],
  ["a picture with its placeholder", ["image.png"], ["image.png"], "\uFFFC"],
  [
    "a picture with placeholder lines",
    ["image.png"],
    ["image.png"],
    "\uFFFC\n\uFFFC\n",
  ],
  ["text, a placeholder and a picture", [], ["image.png"], "Lunch\n\uFFFC"],
  ["text alone", [], [], "notes"],
])("%s attaches %j", (_shape, expected, names, text, html) => {
  expect(
    pastedFiles(clipboard(names, text, html)).map((file) => file.name),
  ).toEqual(expected);
});

it.each<[shape: string, names: string[], text: string, html: string]>([
  [
    "a link alone",
    [],
    "https://example.com/",
    '<a href="https://example.com/">https://example.com/</a>',
  ],
  [
    "text and a picture from Excel",
    ["image.png"],
    "Q3 revenue\t$4.2M",
    "<table><tr><td>Q3 revenue</td><td>$4.2M</td></tr></table>",
  ],
])(
  "%s pastes as text without reading its HTML",
  (_shape, names, text, html) => {
    const read: string[] = [];
    expect(pastedFiles(clipboard(names, text, html, read))).toEqual([]);
    expect(read).not.toContain("text/html");
  },
);

it("attaches nothing without a clipboard", () => {
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

it("collects the pictures a rich paste holds as blob: URLs, once each", () => {
  const read: string[] = [];
  const blob = "blob:http://127.0.0.1:4873/ba90c5a8";
  const chart = "blob:http://127.0.0.1:4873/5f0e2c71";
  // WebKit's HTML for a TextEdit copy: blob: pictures between paragraphs.
  const html = [
    "<p><span>Lunch budget notes for Q3.</span></p>",
    `<p><span><img src="${blob}" alt="Attachment.png"></span></p>`,
    `<p><img src="${chart}" alt="Revenue chart"></p>`,
    `<p><img src="${blob}" alt="Attachment.png"></p>`,
    '<p><img src="https://example.com/logo.png" alt="logo.png"></p>',
    '<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="dot.png"></p>',
    "<p><span>Venue costs went up twelve percent.</span></p>",
  ].join("\n");
  expect(
    pastedInlineImages(clipboard([], "Lunch\n\uFFFC\nVenue", html, read)),
  ).toEqual([
    { src: blob, name: "Attachment.png" },
    { src: chart, name: undefined },
  ]);
  expect(read).toEqual(["text/html"]);
});

it.each<[shape: string, html?: string]>([
  [
    "a copied web page's images",
    '<p>Our logo</p><img src="https://example.com/logo.png">',
  ],
  [
    "a Chrome web page copy with a lazy-load placeholder",
    '<p>Result</p><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">',
  ],
  [
    "an inline favicon",
    '<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="favicon.png">Example</p>',
  ],
  ["HTML without pictures", "<p>notes</p>"],
  ["no HTML"],
])("collects no pictures from %s", (_shape, html) => {
  expect(pastedInlineImages(clipboard([], "notes", html))).toEqual([]);
});

it.each<[shape: string, names: string[], text: string, html: string]>([
  [
    "a TextEdit copy with a picture",
    [],
    "Lunch\n\uFFFC",
    '<p>Lunch</p><p><img src="blob:http://127.0.0.1:4873/ba90c5a8" alt="Attachment.png"></p>',
  ],
  [
    "a link-only cell and a picture from Excel",
    ["image.png"],
    "https://example.com/",
    '<table><tr><td><a href="https://example.com/">https://example.com/</a></td></tr></table>',
  ],
])(
  "%s reads its HTML once for the composer and its editor",
  (_shape, names, text, html) => {
    const read: string[] = [];
    const data = clipboard(names, text, html, read);
    // The composer's paste capture, then the editor's paste handler.
    expect(pastedFiles(data)).toEqual([]);
    pastedInlineImages(data);
    expect(pastedFiles(data)).toEqual([]);
    expect(pastedHtml(data)).toBe(html);
    expect(read.filter((type) => type === "text/html")).toEqual(["text/html"]);
  },
);

it("collects no pictures without a clipboard", () => {
  expect(pastedInlineImages(null)).toEqual([]);
});

it("reads pasted pictures in order, names unnamed ones and counts the ones left out", async () => {
  const blobs: Record<string, Blob> = {
    "blob:named": new Blob(["a"], { type: "image/png" }),
    "blob:jpeg": new Blob(["bb"], { type: "image/jpeg" }),
    "blob:text": new Blob(["c"], { type: "text/plain" }),
    "blob:png": new Blob(["d"], { type: "image/png" }),
    "blob:icon": new Blob(["e"], { type: "image/x-icon" }),
    "blob:svg": new Blob(["f"], { type: "image/svg+xml" }),
    "blob:ms-icon": new Blob(["g"], { type: "image/vnd.microsoft.icon" }),
    "blob:psd": new Blob(["h"], { type: "image/vnd.adobe.photoshop" }),
  };
  const fetch = vi.fn(async (src: string) => {
    const blob = blobs[src];
    if (!blob) throw new TypeError("Failed to fetch");
    return { blob: async () => blob } as Response;
  });
  vi.stubGlobal("fetch", fetch);
  try {
    const { files, unread } = await fetchPastedImages([
      { src: "blob:named", name: "Attachment.png" },
      { src: "blob:revoked" },
      { src: "blob:jpeg" },
      { src: "blob:text", name: "notes.png" },
      { src: "blob:png" },
      { src: "blob:icon" },
      { src: "blob:svg" },
      { src: "blob:ms-icon" },
      { src: "blob:psd" },
    ]);
    expect(files.map((file) => [file.name, file.type, file.size])).toEqual([
      ["Attachment.png", "image/png", 1],
      ["Pasted image.jpg", "image/jpeg", 2],
      ["Pasted image 2.png", "image/png", 1],
      ["Pasted image 3.ico", "image/x-icon", 1],
      ["Pasted image 4.svg", "image/svg+xml", 1],
      ["Pasted image 5.ico", "image/vnd.microsoft.icon", 1],
      ["Pasted image 6.png", "image/vnd.adobe.photoshop", 1],
    ]);
    // The revoked URL and the text blob.
    expect(unread).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(9);
  } finally {
    vi.unstubAllGlobals();
  }
});
