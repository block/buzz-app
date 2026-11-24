const copies = new Map<string, readonly string[]>();
const REMEMBERED_COPIES = 10;

/** Remember who wrote a timeline copy; returns the id to stamp on its HTML. */
export function stampCopiedAuthors(authors: readonly string[]) {
  if (!authors.length) return;
  const id = crypto.randomUUID();
  copies.set(id, [...new Set(authors)]);
  for (const oldest of copies.keys()) {
    if (copies.size <= REMEMBERED_COPIES) break;
    copies.delete(oldest);
  }
  return id;
}

/** Who wrote pasted timeline HTML. Clipboard HTML is untrusted, so only an id
 * this app issued names anyone. */
export function copiedAuthors(html: string): readonly string[] {
  if (!html.includes("data-copy-id")) return [];
  const id = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector("[data-buzz-copy][data-copy-id]")
    ?.getAttribute("data-copy-id");
  return (id && copies.get(id)) || [];
}
