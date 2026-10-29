import { npubEncode } from "nostr-tools/nip19";
import type { Team } from "./store";

/** An agent a roster can name: by name and npub, or by npub alone when its
 * name is not known yet. */
export type Teammate = Readonly<{ pubkey: string; name?: string }>;

/** The team sections for agent `self`: each team it is on, its members that
 * still exist by name and npub (by npub alone where `agents` has no name),
 * and the team's instructions. */
export function teamPrompt(
  teams: readonly Team[],
  agents: readonly Teammate[],
  self: string,
) {
  const names = new Map(agents.map((agent) => [agent.pubkey, agent.name]));
  return teams
    .filter((team) => team.members.includes(self))
    .map((team) => {
      const roster = team.members.flatMap((pubkey) => {
        if (!names.has(pubkey)) return [];
        const name = names.get(pubkey);
        const npub = npubEncode(pubkey);
        return [
          `- ${name === undefined ? npub : `${name} (${npub})`}${pubkey === self ? ", you" : ""}`,
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
