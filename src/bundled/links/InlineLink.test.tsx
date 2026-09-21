import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { targetLink } from "../../features/navigation/targets";
import { InlineLink, LinkLabel, linkKind } from "./InlineLink";
import {
  LinkLabelContext,
  LinkContentContext,
} from "../../features/conversation/LinkLabelContext";

it("identifies exact GitHub hosts, ordinary websites, and valid Buzz locators", () => {
  expect(linkKind("https://github.com/block/buzz")).toBe("github");
  expect(linkKind("https://github.com.example.com/block/buzz")).toBe("web");
  expect(linkKind("https://example.com/github.com")).toBe("web");
  expect(linkKind(targetLink({ version: 1, kind: "home" }))).toBe("buzz");
  expect(
    linkKind(
      targetLink({
        version: 1,
        kind: "conversation",
        scope: {
          viewer: "1".repeat(64),
          communityOrigin: "https://example.com",
        },
        channelId: "general",
        messageId: "2".repeat(64),
        threadRootId: "2".repeat(64),
      }),
    ),
  ).toBe("thread");
});

it.each([
  ["buzz://channel/general", "channel", "Channel"],
  [`buzz://message?channel=general&id=${"a".repeat(64)}`, "message", "Message"],
  [
    `buzz://message?channel=general&id=${"a".repeat(64)}&thread=${"b".repeat(64)}`,
    "thread",
    "Thread",
  ],
])("renders semantic Buzz labels for %s", (href, kind, label) => {
  const html = renderToStaticMarkup(<InlineLink href={href} />);
  expect(html).toContain(`data-link-kind="${kind}"`);
  expect(html.replace(/<[^>]+>/g, "")).toBe(label);
  expect(html).toContain('href="buzz://');
});

it.each([
  "javascript:alert(1)",
  "data:text/html,hello",
  "buzz://unknown",
  "not a URL",
])("leaves unsupported destinations as plain text: %s", (href) => {
  expect(
    renderToStaticMarkup(<InlineLink href={href}>Reference</InlineLink>),
  ).toBe("Reference");
});

it("preserves the destination and readable full label", () => {
  const href = "https://github.com/block/buzz/issues/1234";
  const markup = renderToStaticMarkup(
    <InlineLink href={href} target="_blank" rel="noreferrer" />,
  );
  expect(markup).toContain(`href="${href}"`);
  expect(markup).toContain('data-kind="github"');
  expect(markup).toContain('aria-hidden="true"');
  expect(markup.replace(/<[^>]+>/g, "")).toBe(href);
});

it.each([
  ["https://drive.google.com/drive/folders/example", "drive"],
  ["https://docs.google.com/document/d/example/edit", "document"],
  ["https://docs.google.com/spreadsheets/d/example/edit", "spreadsheet"],
  ["https://docs.google.com/presentation/d/example/edit", "presentation"],
  ["https://docs.google.com/forms/d/example/edit", "drive"],
])("recognizes Google Drive file types: %s", (url, kind) => {
  expect(linkKind(url)).toBe(kind);
});

it.each([
  ["https://www.figma.com/design/example", "figma"],
  ["https://www.notion.so/example", "notion"],
  ["https://team.notion.site/example", "notion"],
  ["https://workspace.slack.com/archives/example", "slack"],
  ["https://app.slack.com/client/example", "slack"],
  ["https://www.dropbox.com/scl/fi/example", "dropbox"],
  ["https://db.tt/example", "dropbox"],
  ["https://onedrive.live.com/?id=example", "onedrive"],
  ["https://1drv.ms/w/example", "onedrive"],
  ["https://example-my.sharepoint.com/personal/example", "onedrive"],
  ["https://example.sharepoint.com/sites/example", "web"],
  ["https://example-my.sharepoint.com.evil.test/personal/example", "web"],
  ["https://gitlab.com/example/project", "gitlab"],
  ["https://www.youtube.com/watch?v=example", "youtube"],
  ["https://youtu.be/example", "youtube"],
  ["https://www.loom.com/share/example", "loom"],
  ["https://us02web.zoom.us/j/example", "zoom"],
  ["https://zoom.com/j/example", "zoom"],
  ["https://teams.microsoft.com/l/meetup-join/example", "teams"],
  ["https://teams.live.com/meet/example", "teams"],
  ["https://teams.cloud.microsoft/l/meetup-join/example", "teams"],
])("renders the service icon for %s", (href, kind) => {
  expect(linkKind(href)).toBe(kind);
  const markup = renderToStaticMarkup(<InlineLink href={href} />);
  expect(markup).toContain(`data-link-kind="${kind}"`);
  expect(markup).toContain(`href="${href}"`);
});

it.each([44, 45, 46, 200])(
  "caps raw URL labels at 45 characters (source length %i)",
  (length) => {
    const href = "https://figma.com/design/".padEnd(length, "a");
    const markup = renderToStaticMarkup(<InlineLink href={href} />);
    const text = markup.replace(/<[^>]+>/g, "");
    expect(markup).toContain(`href="${href}"`);
    expect(text).toBe(length <= 45 ? href : `${href.slice(0, 44)}…`);
  },
);

it("preserves authored labels on long URLs", () => {
  const href = `https://figma.com/design/${"a".repeat(100)}`;
  const label = "View the full design and all of the discussion notes";
  const markup = renderToStaticMarkup(
    <InlineLink href={href}>{label}</InlineLink>,
  );
  expect(markup.replace(/<[^>]+>/g, "")).toBe(label);
  expect(markup).toContain(`href="${href}"`);
});

it("truncates a Unicode URL when Markdown encodes its destination", () => {
  const label =
    "https://www.figma.com/design/example/Builderlab-—-Branding?node-id=1119-21207";
  const href = new URL(label).href;
  const markup = renderToStaticMarkup(
    <LinkLabelContext value={label}>
      <LinkContentContext value={[label]}>
        <LinkLabel href={href} />
      </LinkContentContext>
    </LinkLabelContext>,
  );
  expect(markup.replace(/<[^>]+>/g, "")).toBe(`${label.slice(0, 44)}…`);
});

it.each([
  "figma.com",
  "notion.so",
  "slack.com",
  "dropbox.com",
  "onedrive.live.com",
  "gitlab.com",
  "youtube.com",
  "loom.com",
  "zoom.us",
  "teams.microsoft.com",
])("does not brand lookalike destinations for %s", (host) => {
  expect(linkKind(`https://${host}.example.com/file`)).toBe("web");
  expect(linkKind(`https://fake${host}/file`)).toBe("web");
  expect(linkKind(`https://example.com/${host}`)).toBe("web");
  expect(linkKind(`https://${host}@example.com/file`)).toBe("web");
});
it("does not mistake lookalike hosts or URL paths for Google Drive", () => {
  expect(linkKind("https://drive.google.com.example.com/file")).toBe("web");
  expect(linkKind("https://example.com/drive.google.com")).toBe("web");
});

it("renders the supplied OneDrive brand asset with separate masks for repeated links", () => {
  const markup = renderToStaticMarkup(
    <>
      <InlineLink href="https://1drv.ms/a">OneDrive A</InlineLink>
      <InlineLink href="https://1drv.ms/b">OneDrive B</InlineLink>
    </>,
  );
  expect(markup.replace(/<[^>]+>/g, "")).toBe("OneDrive AOneDrive B");
  expect(markup.match(/aria-hidden="true"/g)).toHaveLength(2);
  expect(markup.match(/viewBox="0 0 32 32"/g)).toHaveLength(2);
  expect(markup.match(/mask-type:alpha/g)).toHaveLength(2);
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  expect(ids).toHaveLength(10);
  expect(new Set(ids).size).toBe(ids.length);
  const svgs = [...markup.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/g)].map(
    (match) => match[0],
  );
  expect(svgs).toHaveLength(2);
  for (const svg of svgs) {
    const localIds = [...svg.matchAll(/\bid="([^"]+)"/g)].map(
      (match) => match[1],
    );
    const references = [...svg.matchAll(/url\(#([^)]*)\)/g)].map(
      (match) => match[1],
    );
    expect(references).toHaveLength(5);
    for (const reference of references) expect(localIds).toContain(reference);
    expect(
      [...svg.matchAll(/<path\b[^>]* d="([^"]+)"/g)].map((match) => match[1]),
    ).toEqual([
      "M7.82979 26C3.50549 26 0 22.5675 0 18.3333C0 14.1921 3.35322 10.8179 7.54613 10.6716C9.27535 7.87166 12.4144 6 16 6C20.6308 6 24.5169 9.12183 25.5829 13.3335C29.1316 13.3603 32 16.1855 32 19.6667C32 23.0527 29 26 25.8723 25.9914L7.82979 26Z",
      "M7.83017 26.0001C5.37824 26.0001 3.18957 24.8966 1.75391 23.1691L18.0429 16.3335L30.7089 23.4647C29.5926 24.9211 27.9066 26.0001 26.0004 25.9915C23.1254 26.0001 12.0629 26.0001 7.83017 26.0001Z",
      "M25.5785 13.3149L18.043 16.3334L30.709 23.4647C31.5199 22.4065 32.0004 21.0916 32.0004 19.6669C32.0004 16.1857 29.1321 13.3605 25.5833 13.3337C25.5817 13.3274 25.5801 13.3212 25.5785 13.3149Z",
      "M7.06445 10.7028L18.0423 16.3333L25.5779 13.3148C24.5051 9.11261 20.6237 6 15.9997 6C12.4141 6 9.27508 7.87166 7.54586 10.6716C7.3841 10.6773 7.22358 10.6877 7.06445 10.7028Z",
      "M1.7535 23.1687L18.0425 16.3331L7.06471 10.7026C3.09947 11.0792 0 14.3517 0 18.3331C0 20.1665 0.657197 21.8495 1.7535 23.1687Z",
    ]);
    expect(
      [...svg.matchAll(/stop-color="([^"]+)"/g)].map((match) => match[1]),
    ).toEqual([
      "#2086B8",
      "#46D3F6",
      "#1694DB",
      "#62C3FE",
      "#0D3D78",
      "#063B83",
      "#16589B",
      "#1464B7",
    ]);
  }
});
