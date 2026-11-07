import type { AgentVoiceSeat } from "../../features/agents/service";
import { openVoiceMedia } from "../../features/huddle/voice-media";
import type { GooseProcess } from "./goose";
import {
  REQUEST_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
} from "../../features/agent-harness/acp/process";

/** Goose owns turn-taking and tool delegation on this same ACP session. */
export function openVoice(
  process: GooseProcess,
  sessionId: string,
  seat: AgentVoiceSeat,
  start: <T>(run: () => Promise<T>) => Promise<T>,
) {
  let interactionId: string | undefined;
  let endedId: string | undefined;
  let answer: (sdp: string) => void = () => {};
  let pending:
    | { id: string; role: "owner" | "agent"; text: string }
    | undefined;
  return openVoiceMedia("Goose", seat.signal, seat.output, seat.ended, {
    gatherCandidates: true,
    subscribe: (receive, fail) => {
      answer = receive;
      let closed = false;
      void process.exited.then(() => {
        if (!closed) fail(new Error("Goose closed"));
      });
      const off = process.onNotification((method, params) => {
        if (seat.signal.aborted || params.sessionId !== sessionId) return;
        const update = params.update as
          | {
              sessionUpdate?: string;
              interactionId?: string;
              messageId?: string;
              content?: { type?: string; text?: string };
              _meta?: {
                goose?: { liveTranscript?: boolean; messageId?: string };
              };
            }
          | undefined;
        if (!update) return;
        if (
          method === "_goose/unstable/session/update" &&
          update.sessionUpdate === "live_voice_interaction_ended"
        ) {
          endedId = update.interactionId;
          if (interactionId && endedId === interactionId)
            fail(new Error("Goose voice ended"));
          return;
        }
        if (
          method !== "session/update" ||
          !update._meta?.goose?.liveTranscript ||
          update.content?.type !== "text" ||
          typeof update.content.text !== "string"
        )
          return;
        const role =
          update.sessionUpdate === "user_message_chunk"
            ? "owner"
            : update.sessionUpdate === "agent_message_chunk"
              ? "agent"
              : undefined;
        const id = update.messageId ?? update._meta.goose.messageId;
        if (!role || !id) return;
        if (pending && pending.id !== id) {
          if (pending.text.trim())
            void seat.transcript(pending.role, pending.text).catch(fail);
          pending = undefined;
        }
        pending ??= { id, role, text: "" };
        // Bound retained transcript text just as the harness bounds context.
        pending.text = (pending.text + update.content.text).slice(-32_768);
      });
      return () => {
        closed = true;
        off();
        pending = undefined;
      };
    },
    async start(offerSdp) {
      const result = (await start(() =>
        process.request(
          "_goose/unstable/session/live-voice/start",
          {
            sessionId,
            offerSdp,
          },
          REQUEST_TIMEOUT_MS,
        ),
      )) as { interactionId?: unknown; answerSdp?: unknown };
      if (typeof result.interactionId === "string")
        interactionId = result.interactionId;
      if (
        !interactionId ||
        typeof result.answerSdp !== "string" ||
        !result.answerSdp
      )
        throw new Error("Goose returned an invalid voice answer");
      if (endedId === interactionId) throw new Error("Goose voice ended");
      answer(result.answerSdp);
    },
    async stop() {
      if (interactionId)
        await process.request(
          "_goose/unstable/session/live-voice/stop",
          {
            sessionId,
            interactionId,
          },
          STOP_TIMEOUT_MS,
        );
    },
  });
}
