import { openVoiceMedia } from "../../features/huddle/voice-media";
import type { AppServer } from "./rpc";

export function openVoice(
  rpc: AppServer,
  threadId: string,
  signal: AbortSignal,
  output: (samples: number[]) => Promise<void>,
  ended: (error?: Error) => void,
  instructions: string,
  thinking?: (active: boolean) => void,
) {
  return openVoiceMedia("Codex", signal, output, ended, {
    subscribe: (answer, fail) =>
      rpc.onMessage(({ method, params }) => {
        const p = params as
          | { threadId?: string; sdp?: string; message?: string }
          | undefined;
        if (method === "connection/closed")
          return fail(new Error(p?.message ?? "Codex closed"));
        if (p?.threadId !== threadId) return;
        if (method === "thread/realtime/sdp" && p.sdp) answer(p.sdp);
        if (
          method === "thread/realtime/error" ||
          method === "thread/realtime/closed"
        )
          fail(new Error(p.message ?? "Codex voice ended"));
      }),
    start: (sdp) =>
      rpc.request("thread/realtime/start", {
        threadId,
        transport: { type: "webrtc", sdp },
        version: "v3",
        outputModality: "audio",
        clientManagedHandoffs: false,
        realtimeStartInstructions: instructions,
      }),
    stop: () => rpc.request("thread/realtime/stop", { threadId }),
    thinking,
  });
}
