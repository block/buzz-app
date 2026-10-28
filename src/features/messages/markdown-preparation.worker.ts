import { byteSize } from "../relay/budget";
import { prepareMarkdown } from "./markdown-preparation";
import {
  parseMessageMarkdown,
  type MarkdownPreparationRequest,
  type MarkdownPreparationReply,
} from "./message-markdown-tree";

self.onmessage = ({ data }: MessageEvent<MarkdownPreparationRequest>) => {
  const results: MarkdownPreparationReply["results"] = [];
  let bytes = 0;
  for (const { content, parse } of data.contents) {
    try {
      const prepared = prepareMarkdown(content);
      const tree =
        parse && prepared.kind === "markdown"
          ? parseMessageMarkdown(prepared.content)
          : undefined;
      const preparedBytes = byteSize([content, prepared]);
      const treeBytes = tree ? byteSize([prepared.content, tree]) : 0;
      bytes += preparedBytes + treeBytes;
      if (bytes > 6 * 1024 * 1024) break;
      results.push({ content, prepared, tree, preparedBytes, treeBytes });
    } catch {
      // Rendering retains the ordinary preparation/parser fallback.
    }
  }
  self.postMessage({ id: data.id, results } satisfies MarkdownPreparationReply);
};
