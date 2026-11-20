// Builds the base prompt from its sections. The host picks each section's
// text before the model sees it, so the prompt states one rule per topic.
import { leanBasePromptPreference } from "../lean-base-prompt-preference";
import { type Facts, SECTIONS } from "./index";

// Lean omits optional workflow guidance, never the host-owned contract or
// communication rules. Keep one source of text for both modes.
const FULL_GUIDANCE = new Set([
  "memory",
  "engineering",
  "commit-identity",
  "autonomy",
]);

export function composeBase(facts: Facts, lean = leanBasePromptPreference()) {
  const text = SECTIONS.filter(
    (section) => !lean || !FULL_GUIDANCE.has(section.id),
  )
    .map((section) => {
      const body = (
        typeof section.text === "string" ? section.text : section.text(facts)
      ).trim();
      return section.title ? `## ${section.title}\n\n${body}` : body;
    })
    .join("\n\n");
  return { text };
}
