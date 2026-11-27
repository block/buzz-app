import { threadReplyTags } from "../relay/thread-reference";
import { MESSAGE_SOURCE_TAG } from "../relay/contracts";
import { unconfirmedAgentEvent, type AgentEventTemplate } from "./native";

type Draft = {
  text: string;
  enabled: boolean;
  paused?: boolean;
  sent?: string;
  id?: string;
  editAt?: number;
  pending?: Promise<void> | undefined;
};

/** A spoken line keeps the same original message through its final revision. */
export function streamVoiceTranscript(
  destination: Readonly<{
    channelId: string;
    root?: string;
    parentId?: string;
  }>,
  signal: AbortSignal,
  enabled: () => boolean,
  publish: (
    event: AgentEventTemplate,
  ) => Promise<{ id: string; created_at: number }>,
) {
  const channelTag = ["h", destination.channelId];
  const start = (text: string) =>
    publish({
      kind: 9,
      content: text,
      tags: [
        channelTag,
        [MESSAGE_SOURCE_TAG, "huddle-transcript"],
        ...threadReplyTags(destination.root, destination.parentId),
      ],
    });
  let draft: Draft | undefined;
  const flush = (line: Draft): Promise<void> =>
    (line.pending ??= (async () => {
      while (!signal.aborted && line.text.trim() && line.text !== line.sent) {
        // The relay resolves edit precedence at whole-second precision.
        if (line.editAt !== undefined) {
          const remaining = (line.editAt + 1) * 1000 - Date.now();
          if (remaining > 0)
            await new Promise((resolve) => setTimeout(resolve, remaining));
        }
        if (signal.aborted) return;
        const text = line.text;
        if (line.id) {
          const edit = await publish({
            kind: 40003,
            content: text,
            tags: [channelTag, ["e", line.id]],
          });
          line.editAt = edit.created_at;
        } else {
          try {
            line.id = (await start(text)).id;
          } catch (error) {
            // An uncertain first write may be visible. Keep its message ID
            // so the final transcript cannot duplicate it.
            const id = unconfirmedAgentEvent(error);
            if (!id) throw error;
            line.id = id;
          }
        }
        line.sent = text;
      }
    })().finally(() => {
      line.pending = undefined;
    }));
  return {
    append(delta: string) {
      if (signal.aborted) return;
      draft ??= { text: "", enabled: enabled() };
      const line = draft;
      if (!line.enabled || line.paused) return;
      line.text += delta;
      if (line.pending) return;
      void flush(line).catch((error: unknown) => {
        line.paused = true;
        if (!signal.aborted)
          console.warn("Huddle live transcript update failed", error);
      });
    },
    async finish(text: string) {
      const line = draft;
      draft = undefined;
      if (signal.aborted || !text.trim()) return;
      if (!line?.enabled) {
        await start(text);
        return;
      }
      line.text = text;
      await line.pending?.catch(() => {});
      await flush(line);
    },
  };
}
