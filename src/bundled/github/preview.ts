import {
  MAX_MARKDOWN_LENGTH,
  scanMarkdown,
} from "../../features/relay/message-content";
import {
  attachmentFor,
  attachmentMetadata,
  bodyUrl,
  inertHtml,
} from "./attachments";

/** Summaries are text and vetted images, never rendered HTML. */
export function bodyPreview(
  body: string,
  bodyHtml: string | undefined,
  base: string,
) {
  if (body.length > MAX_MARKDOWN_LENGTH)
    return { text: "Long message · expand to read", images: [] as string[] };
  const scan = scanMarkdown(body);
  if (scan.tooDeep)
    return { text: "Long message · expand to read", images: [] as string[] };
  const metadata = attachmentMetadata(bodyHtml);
  const images = new Set<string>();
  const addImage = (source: string) => {
    const url = bodyUrl(source, base);
    if (url && attachmentFor(url, metadata, true)) images.add(url);
  };
  const text = (node: typeof scan.tree): string => {
    if (node.type === "definition") return "";
    if (node.type === "image" || node.type === "imageReference") {
      addImage(
        node.url ??
          scan.definitions.get(node.identifier?.toLowerCase() ?? "") ??
          "",
      );
      return "";
    }
    if (node.type === "html") {
      const fragment = inertHtml(node.value ?? "");
      for (const element of fragment.querySelectorAll(
        "script, style, template",
      ))
        element.remove();
      for (const image of fragment.querySelectorAll("img"))
        addImage(image.getAttribute("src") ?? "");
      for (const br of fragment.querySelectorAll("br")) br.replaceWith("\n");
      for (const block of fragment.querySelectorAll(
        "p, div, li, summary, tr, h1, h2, h3, h4, h5, h6",
      ))
        block.append("\n");
      return fragment.textContent ?? "";
    }
    return (
      node.value ??
      (node.children ?? [])
        .map(text)
        .join(
          ["root", "list", "listItem", "blockquote"].includes(node.type)
            ? "\n"
            : "",
        )
    );
  };
  // Walk every block for attachments, but use only the first readable line.
  const lines = (scan.tree.children ?? []).map(text);
  for (const link of scan.links) {
    const source =
      link.url ??
      scan.definitions.get(link.identifier?.toLowerCase() ?? "") ??
      "";
    const safe = bodyUrl(source, base);
    if (safe && attachmentFor(safe, metadata)?.kind === "image") addImage(safe);
  }
  const first = lines
    .flatMap((line) => line.split(/\r?\n/))
    .map((line) => line.trim())
    .find(Boolean);
  return {
    text: first
      ? first.replace(/\s+/g, " ").slice(0, 280)
      : images.size
        ? "Images attached"
        : body.trim()
          ? "Message · expand to read"
          : "",
    images: [...images],
  };
}
