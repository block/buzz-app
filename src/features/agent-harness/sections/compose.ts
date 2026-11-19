// Builds the base prompt from its sections. The host picks each section's
// text before the model sees it, so the prompt states one rule per topic.
import { type Facts, SECTIONS } from "./index";

export function composeBase(facts: Facts = {}) {
  const text = SECTIONS.map((section) =>
    (typeof section.text === "string"
      ? section.text
      : section.text(facts)
    ).trim(),
  ).join("\n\n");
  return { text };
}
