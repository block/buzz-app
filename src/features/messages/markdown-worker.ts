import type { ChannelMessage } from "../relay/contracts";
import { ByteLru } from "../relay/budget";
import type { PreparedMarkdown } from "./markdown-preparation";
import type { Root } from "mdast";
import type {
  MarkdownPreparationReply,
  MarkdownPreparationRequest,
} from "./message-markdown-tree";

// These are serialized-byte budgets, matching the relay's ByteLru convention.
// Actual heap usage also includes objects and is measured separately.
const prepared = new ByteLru<{ owner: object; value: PreparedMarkdown }>(
  256,
  2 * 1024 * 1024,
);
const trees = new ByteLru<{ owner: object; value: Root }>(256, 4 * 1024 * 1024);

export function preparedMarkdown(content: string) {
  return prepared.get(content)?.value;
}

// Remark transformers mutate their input. A transferred tree is consumed once.
export function takeMarkdownTree(source: string) {
  const tree = trees.get(source);
  trees.delete(source);
  return tree?.value;
}

export function createMarkdownPreparation() {
  const owner = {};
  let worker: Worker | null | undefined;
  let epoch = 0;
  let nextId = 0;
  const pending = new Map<number, (reply?: MarkdownPreparationReply) => void>();
  const stop = () => {
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
    worker = null;
    for (const settle of pending.values()) settle();
    pending.clear();
  };
  const start = () => {
    if (worker !== undefined) return worker;
    worker = null;
    // Vite's development optimizer shares page dependencies with workers.
    // Only production worker bundles select the DOM-free entity decoder.
    if (import.meta.env.DEV || typeof Worker === "undefined") return worker;
    try {
      worker = new Worker(
        new URL("./markdown-preparation.worker.ts", import.meta.url),
        { type: "module" },
      );
      worker.onmessage = ({ data }: MessageEvent<MarkdownPreparationReply>) =>
        pending.get(data.id)?.(data);
      worker.onerror = (event) => {
        event.preventDefault();
        stop();
      };
      worker.onmessageerror = stop;
    } catch {
      stop();
    }
    return worker;
  };
  return {
    async prepare(rows: readonly ChannelMessage[], signal: AbortSignal) {
      if (signal.aborted) return;
      const contents: MarkdownPreparationRequest["contents"] = [];
      const seen = new Set<string>();
      let bytes = 0;
      for (const row of rows) {
        // These render through other owners or project their body again.
        if (row.diff || row.agentEnvelope || /buzz:/i.test(row.content))
          continue;
        if (seen.has(row.content) || prepared.peek(row.content)) continue;
        seen.add(row.content);
        bytes += row.content.length * 2;
        if (bytes > 1024 * 1024) break;
        contents.push({
          content: row.content,
          parse:
            !row.mentions.length &&
            !row.mentionReferences?.length &&
            !row.emoji?.length &&
            !row.content.includes("||") &&
            !/&#(?:58|46|64|x3a|x2e|x40);/i.test(row.content),
        });
      }
      if (!contents.length) return;
      const target = start();
      if (!target) return;
      const generation = epoch;
      const id = nextId++;
      const reply = await new Promise<MarkdownPreparationReply | undefined>(
        (resolve) => {
          const settle = (value?: MarkdownPreparationReply) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            pending.delete(id);
            resolve(value);
          };
          const abort = () => {
            stop();
            worker = undefined;
          };
          // A stalled worker must not turn a history read into a long spinner.
          // Stop it too: otherwise timed-out work competes with the fallback.
          const timer = setTimeout(stop, 100);
          signal.addEventListener("abort", abort, { once: true });
          pending.set(id, settle);
          try {
            target.postMessage({
              id,
              contents,
            } satisfies MarkdownPreparationRequest);
          } catch {
            stop();
          }
        },
      );
      if (signal.aborted || epoch !== generation) return;
      for (const result of reply?.results ?? []) {
        prepared.set(
          result.content,
          {
            owner,
            value: Object.freeze(
              result.prepared.kind === "plain"
                ? result.prepared
                : {
                    ...result.prepared,
                    literalRanges: Object.freeze(
                      result.prepared.literalRanges.map((range) =>
                        Object.freeze(range),
                      ),
                    ),
                    spoilerDelimiters: Object.freeze(
                      result.prepared.spoilerDelimiters,
                    ),
                  },
            ),
          },
          result.preparedBytes,
        );
        if (result.tree && result.prepared.kind === "markdown")
          trees.set(
            result.prepared.content,
            { owner, value: result.tree },
            result.treeBytes,
          );
      }
    },
    clear() {
      epoch++;
      stop();
      worker = undefined;
      for (const [key, entry] of prepared.entries())
        if (entry.owner === owner) prepared.delete(key);
      for (const [key, entry] of trees.entries())
        if (entry.owner === owner) trees.delete(key);
    },
  };
}
