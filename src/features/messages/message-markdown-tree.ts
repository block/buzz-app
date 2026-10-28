import type { Root } from "mdast";
import { fromMarkdown, type Options } from "mdast-util-from-markdown";
import remarkGfm from "remark-gfm";
import type { PreparedMarkdown } from "./markdown-preparation";

const syntax: {
  micromarkExtensions?: Options["extensions"];
  fromMarkdownExtensions?: Options["mdastExtensions"];
} = {};
remarkGfm.call({ data: () => syntax });

export function parseMessageMarkdown(source: string): Root {
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
