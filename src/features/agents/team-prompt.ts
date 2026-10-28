import { npubEncode } from "nostr-tools/nip19";
import type { Team } from "./store";

/** The team sections for agent `self`: each team it is on, its members that
 * still exist by name and npub, and the team's instructions. */
export function teamPrompt(
  teams: readonly Team[],
  agents: readonly Readonly<{ pubkey: string; name: string }>[],
  self: string,
) {
  const names = new Map(agents.map((agent) => [agent.pubkey, agent.name]));
  return teams
    .filter((team) => team.members.includes(self))
    .map((team) => {
      const roster = team.members.flatMap((pubkey) => {
        const name = names.get(pubkey);
        return name === undefined
          ? []
          : [
              `- ${name} (${npubEncode(pubkey)})${pubkey === self ? ", you" : ""}`,
            ];
      });
      return [
        "<team>",
        `You are on the team ${JSON.stringify(team.name)}. Its members, you included:`,
        ...roster,
        "Mention a teammate by name, with their npub, to reach them.",
        ...(team.instructions.trim()
          ? [
              "<team-instructions>",
              team.instructions.trim(),
              "</team-instructions>",
            ]
          : []),
        "</team>",
      ].join("\n");
    })
    .join("\n\n");
}
