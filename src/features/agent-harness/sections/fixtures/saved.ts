// The prompts as they were before the base prompt had sections, and the
// inputs that gave them: one agent, its workspace, and a conversation folder
// of its own. The Codex ones also have the Session Model, which Codex got
// after.
import { readFileSync } from "node:fs";

/** What the prompt code gave for the fixture `name`. */
export const saved = (name: string) =>
  readFileSync(new URL(`./${name}.txt`, import.meta.url), "utf8");

export const FRAME = {
  workspace: "/home/owner/.buzz/agents/fixture",
  folder: "/home/owner/code/project",
  system: {
    agent: { name: "Fixture Agent", pubkey: "ab".repeat(32) },
    instructions: "Be terse.",
    repositories:
      "<community-repositories>\nRepositories: /home/owner/.buzz/agents/fixture/REPOS\n</community-repositories>",
    team: "<team>\nCrew\n</team>",
    memory: "I am the fixture agent.",
    notes: "<recent-notes>\nNone.\n</recent-notes>",
  },
} as const;
