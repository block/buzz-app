// The Buzz base prompt every harness plugin gives its agents. A harness fills
// in the parts that depend on how it delivers turns and ends them.
import template from "./base_prompt.md?raw";

export type BasePromptParts = Readonly<{
  /** How the harness wraps an incoming turn, and where its request is. */
  turns: string;
  /** What `final: true` on a `send` does in this harness. */
  final: string;
  /** Whether a turn may end without publishing; a bullet's text. */
  silence: string;
  /** What to do with a draft that is only an acknowledgement. */
  acknowledgement: string;
}>;

export function basePrompt(parts: BasePromptParts) {
  return template
    .replace(/\{\{(\w+)\}\}/g, (_, part: keyof BasePromptParts) =>
      parts[part].trim(),
    )
    .trim();
}
