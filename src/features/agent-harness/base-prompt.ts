// The Buzz base prompt every agent harness plugin gives its agents, before
// its own instructions, and what a turn a mention or DM starts adds to it.
import mentionPrompt from "./mention_prompt.md?raw";
import { composeBase } from "./sections/compose";

export const BASE_PROMPT = composeBase().text;

/** The base prompt, for a conversation in a folder of its own when
 * `workspace`, the agent's workspace as an absolute path, is given. */
export function basePromptFor(workspace?: string) {
  return workspace ? composeBase({ ownFolder: workspace }).text : BASE_PROMPT;
}

/** Shown with each turn a mention or DM starts, and with each message that
 * arrives while one runs: what the agent owes it. Watch, timer and wake
 * turns do not get it; their own sections say what to publish. */
export const MENTION_PROMPT = mentionSection();

/** The `<mention>` section, with a harness's own rules for a mention added. */
export function mentionSection(extra = "") {
  const body = [mentionPrompt, extra]
    .map((part) => part.trim())
    .filter(Boolean);
  return `<mention>\n${body.join("\n\n")}\n</mention>`;
}
