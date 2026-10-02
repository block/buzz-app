import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { AgentDelivery, LiveStep, StepKind } from "@buzz/author";
import { isStepCount, tool, ToolLoopAgent } from "ai";
import { z } from "zod";
import { API_KEY, parseConfig, PROVIDERS, type Config } from "./config.ts";
import { channelOf, fold, messageTags, threadRoot } from "./thread.ts";
import { codingTools } from "./tools.ts";

type Filter = Readonly<{
  kinds?: readonly number[];
  ids?: readonly string[];
  "#h"?: readonly string[];
  "#e"?: readonly string[];
  limit: number;
}>;
type Stored = Parameters<typeof fold>[0][number];
/** What a run needs from the app besides the delivery itself. */
export type Surroundings = {
  /** Reaches the model provider. */
  fetch: typeof fetch;
  /** Reads as the agent's owner: the agent sees what its owner can see. */
  read(
    filters: readonly Filter[],
    signal: AbortSignal,
  ): Promise<readonly Stored[]>;
  /** Display names for pubkeys; a pubkey with no known name is left out. */
  names(pubkeys: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** Model calls in one run; each is one answer or one round of tool calls. */
  maxSteps?: number;
};

/** A run may read, think, run commands and write for this long before the app
 * aborts it. */
export const RUN_TIMEOUT_MS = 30 * 60_000;
export const MAX_STEPS = 128;
const MAX_AUX = 500;
const MAX_LABEL = 120;

function languageModel(
  config: Config,
  apiKey: string,
  fetch: typeof globalThis.fetch,
) {
  const model = config.model.trim() || PROVIDERS[config.provider].model;
  return config.provider === "openai"
    ? createOpenAI({ apiKey, fetch })(model)
    : createAnthropic({ apiKey, fetch })(model);
}

/** The live row for a tool call. The host words the row from `kind` ("Reading",
 * "Running"), so the label is only what was read or run. */
function row(name: string, input: unknown): { kind: StepKind; label?: string } {
  const field = (key: string) => {
    const value = (input as Record<string, unknown> | null)?.[key];
    return typeof value === "string" && value.trim()
      ? { label: value.trim().split("\n", 1)[0]?.slice(0, MAX_LABEL) ?? "" }
      : {};
  };
  switch (name) {
    case "read":
      return { kind: "read", ...field("path") };
    case "ls":
      return { kind: "read", label: ".", ...field("path") };
    case "write":
    case "edit":
      return { kind: "write", ...field("path") };
    case "bash":
      return { kind: "command", ...field("command") };
    case "grep":
    case "find":
      return { kind: "search", ...field("pattern") };
    case "read_messages":
      return {
        kind: "read",
        label:
          (input as { scope?: unknown } | null)?.scope === "channel"
            ? "the channel"
            : "the thread",
      };
    default:
      return { kind: "tool", label: name };
  }
}

const reason = (error: unknown) =>
  String(error instanceof Error ? error.message : error);

/** Answers one mention. The run's steps and the text as it is written show only in
 * the owner's window, through `live`; each finished piece of text is published
 * once as a reply in the mention's thread. */
export async function run(
  delivery: AgentDelivery<unknown>,
  app: Surroundings,
): Promise<void> {
  const { event, agent, live } = delivery;
  // Also ends a command that is still running when the run fails.
  const ending = new AbortController();
  const signal = AbortSignal.any([delivery.signal, ending.signal]);
  const config = parseConfig(delivery.config);
  const channelId = delivery.channelId ?? channelOf(event);
  if (!channelId) throw new Error("The mention has no channel to answer in");
  const rootId = threadRoot(event);
  const maxSteps = app.maxSteps ?? MAX_STEPS;
  const reply = (content: string) =>
    agent.publish({
      kind: 9,
      content,
      tags: messageTags(channelId, rootId),
    });

  const named = async (pubkeys: readonly string[]) => {
    const names = await app
      .names(pubkeys)
      .catch(() => new Map<string, string>());
    return (pubkey: string) =>
      pubkey === agent.pubkey
        ? `${agent.name} (you)`
        : (names.get(pubkey) ?? pubkey);
  };

  const tools = {
    read_messages: tool({
      description:
        "Read recent messages, oldest first: either the thread you were mentioned in, or the top level and replies of the whole channel.",
      inputSchema: z.object({
        scope: z.enum(["thread", "channel"]),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      execute: async ({ scope, limit }) => {
        const found = await app.read(
          scope === "thread"
            ? [
                { ids: [rootId], limit: 1 },
                { kinds: [9], "#h": [channelId], "#e": [rootId], limit },
              ]
            : [{ kinds: [9], "#h": [channelId], limit }],
          signal,
        );
        const ids = found
          .filter((item) => item.kind === 9)
          .map((item) => item.id);
        const changes = ids.length
          ? await app.read(
              [
                {
                  kinds: [40003, 5],
                  "#h": [channelId],
                  "#e": ids,
                  limit: MAX_AUX,
                },
              ],
              signal,
            )
          : [];
        const messages = fold([...found, ...changes]);
        const name = await named([
          ...new Set(messages.map((item) => item.pubkey)),
        ]);
        return messages.map((item) => ({
          id: item.id,
          from: name(item.pubkey),
          pubkey: item.pubkey,
          at: new Date(item.created_at * 1000).toISOString(),
          ...(item.thread ? { thread_id: item.thread } : {}),
          text: item.content,
        }));
      },
    }),
    post_message: tool({
      description:
        "Post a separate message in this channel as yourself. Not for your answer to the mention: that is posted for you.",
      inputSchema: z.object({
        content: z.string().min(1).describe("GitHub-flavored Markdown"),
        thread_id: z
          .string()
          .optional()
          .describe(
            "Id of the message to reply under. Omit for a new top-level message.",
          ),
        mention_pubkeys: z
          .array(z.string())
          .max(8)
          .optional()
          .describe(
            "People to notify. Their names in the text alone do not notify.",
          ),
      }),
      execute: async ({ content, thread_id, mention_pubkeys }) => {
        const posted = await agent.publish({
          kind: 9,
          content,
          tags: messageTags(channelId, thread_id, mention_pubkeys),
        });
        return { id: posted.id };
      },
    }),
    ...(agent.workspace ? codingTools(agent.workspace, signal) : {}),
  };

  // Text and thinking in progress, by the provider's block id.
  const writing = new Map<string, { step: LiveStep; text: string }>();
  const thinking = new Map<string, LiveStep>();
  const calls = new Map<string, LiveStep>();
  try {
    const assistant = new ToolLoopAgent({
      model: languageModel(
        config,
        (await agent.secret(API_KEY)).trim(),
        app.fetch,
      ),
      instructions: [
        config.instructions.trim(),
        `You are ${agent.name}, an agent in Buzz, a team chat app. Your pubkey is ${agent.pubkey}. You run when a message mentions you, and you see only that message unless you read more.`,
        "What you write is posted as your reply in the thread of that message. Each stretch of text you write between tool calls becomes its own message there, so write for the people in the thread and do not narrate every step. Use read_messages when the message depends on earlier conversation. Use post_message only for a separate message, never for the reply itself.",
        agent.workspace
          ? `Your workspace is the directory ${agent.workspace.path} on your owner's computer. read, write, edit and ls work only inside it. bash, grep and find start there, and bash runs with your owner's full access, so stay inside the workspace unless you are asked to go elsewhere. You have at most ${maxSteps} rounds of tool calls, and nothing is remembered between mentions except the files and the thread.`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      tools,
      stopWhen: isStepCount(maxSteps),
    });
    const author = (await named([event.pubkey]))(event.pubkey);
    const result = await assistant.stream({
      prompt: `${author} (pubkey ${event.pubkey}) mentioned you in message ${event.id}:\n\n${event.content}`,
      abortSignal: signal,
    });
    let cutShort = false;
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "reasoning-start":
          thinking.set(part.id, live.step({ kind: "thinking" }));
          break;
        case "reasoning-delta":
          thinking.get(part.id)?.append(part.text);
          break;
        case "reasoning-end":
          thinking.get(part.id)?.finish();
          thinking.delete(part.id);
          break;
        case "text-start":
          writing.set(part.id, {
            step: live.step({ kind: "message" }),
            text: "",
          });
          break;
        case "text-delta": {
          const block = writing.get(part.id);
          if (!block) break;
          block.text += part.text;
          block.step.append(part.text);
          break;
        }
        case "text-end": {
          const block = writing.get(part.id);
          if (!block) break;
          const content = block.text.trim();
          // The row stays until the real message exists, then gives way to it.
          block.step.finish(
            content ? { published: (await reply(content)).id } : undefined,
          );
          writing.delete(part.id);
          break;
        }
        case "tool-call":
          calls.set(part.toolCallId, live.step(row(part.toolName, part.input)));
          break;
        case "tool-result":
          if (!part.preliminary) calls.get(part.toolCallId)?.finish();
          break;
        case "tool-error":
          calls.get(part.toolCallId)?.finish({
            // A failed command's message is its output, then how it ended.
            error: reason(part.error).trim().split("\n").at(-1) ?? "",
          });
          break;
        case "finish":
          cutShort = part.finishReason === "tool-calls";
          break;
        case "error":
          throw part.error;
      }
    }
    // An aborted stream ends without throwing.
    if (delivery.signal.aborted) throw delivery.signal.reason;
    if (cutShort)
      await reply(
        `⚠️ I stopped after ${maxSteps} rounds of tool calls, before I was done.`,
      );
  } catch (error) {
    // Say so where the person is waiting; the Agents page also counts the failure.
    // Once the agent is stopped it can no longer publish, so only a run that
    // failed or ran out of time gets to say so.
    const unsent = [...writing.values()]
      .map((block) => block.text.trim())
      .filter(Boolean);
    const timedOut =
      (delivery.signal.reason as { name?: string } | undefined)?.name ===
      "TimeoutError";
    await reply(
      [
        ...unsent,
        timedOut
          ? "⚠️ I ran out of time before I was done."
          : `⚠️ I couldn't finish: ${reason(error).slice(0, 300)}`,
      ].join("\n\n"),
    ).catch(() => {});
    throw error;
  } finally {
    ending.abort();
  }
}
