import type { Root } from "mdast";
import { fromMarkdown, type Options } from "mdast-util-from-markdown";
import { remarkMessageGfm } from "./remark-message-gfm";
import type { PreparedMarkdown } from "./markdown-preparation";

export function parseMessageMarkdown(source: string): Root {
  const syntax: {
    micromarkExtensions?: Options["extensions"];
    fromMarkdownExtensions?: Options["mdastExtensions"];
  } = {};
  const selected = remarkMessageGfm(source);
  if (typeof selected === "function") selected.call({ data: () => syntax });
  else selected[0].call({ data: () => syntax }, selected[1]);
  return fromMarkdown(source, {
    extensions: syntax.micromarkExtensions ?? [],
    mdastExtensions: syntax.fromMarkdownExtensions ?? [],
  });
}

export type MarkdownPreparationRequest = {
  id: number;
  contents: { content: string; parse: boolean }[];
};
export type MarkdownPreparationResult = {
  content: string;
  prepared: PreparedMarkdown;
  tree?: Root | undefined;
  preparedBytes: number;
  treeBytes: number;
};
export type MarkdownPreparationReply = {
  id: number;
  results: MarkdownPreparationResult[];
};
