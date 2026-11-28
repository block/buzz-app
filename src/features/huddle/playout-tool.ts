import type { Agents } from "../agents/service";
import { relayOrigin } from "../communities/destination";
import { huddleAudio } from "./diagnostics";
import type { Huddles } from "./service";

export const huddlePlayoutToolName = "huddles_playout_events";

export function registerHuddlePlayoutTool(
  agents: Pick<Agents, "addTool" | "snapshot">,
  huddles: Pick<Huddles, "snapshot" | "recentPlayout">,
) {
  if (!huddleAudio.enabled) return;
  agents.addTool({
    name: huddlePlayoutToolName,
    description:
      "Read the last minute of audio diagnostics for your own voice in your owner's active Huddle. events lists relay playback underruns and queue discards. voiceEvents lists gaps in decoded Codex frames, WebRTC loss and audio concealment, sender queue drops, and native relay sequence skips and jitter rejections. Times are Unix milliseconds. The report includes the active playback mode and carries timing and counts only.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async call(client, context, args) {
      if (Object.keys(args).length)
        throw new Error("This tool takes no arguments.");
      const { destination, room } = huddles.snapshot();
      const agentsHere = agents.snapshot();
      const agent =
        agentsHere.status === "ready" &&
        agentsHere.running.find(
          (candidate) =>
            candidate.key === client.key && candidate.pubkey === client.pubkey,
        );
      if (
        !destination ||
        !room ||
        context.channel !== room ||
        !agent ||
        agent.place !== "here" ||
        agent.owner !== destination.viewer ||
        relayOrigin(agent.relay) !== relayOrigin(destination.relayUrl)
      )
        throw new Error(
          "Playback events are only available in your owner's active Huddle.",
        );
      const report = huddles.recentPlayout(room, client.pubkey);
      if (!report)
        throw new Error(
          "Playback events are unavailable for your seat in this Huddle.",
        );
      return JSON.stringify({ ...report, playback: huddleAudio.playback() });
    },
  });
}
