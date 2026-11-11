// The standing instructions plugins give every turn (`Agents.addInstructions`),
// shown the same way whatever harness runs the agent.
import type { TurnInstructions } from "../agents/service";
import { unframed } from "./plugin-wake";

/** One `<plugin-instructions>` section for each plugin's instructions, or
 * undefined when there are none. A plugin's text cannot close its section
 * early or open the turn's event. */
export function pluginInstructions(entries: readonly TurnInstructions[] = []) {
  const sections = entries.map(({ plugin, text }) => {
    const body = unframed(
      text.trim().replace(/<\/(plugin-instructions)/gi, "<\\/$1"),
    );
    return `<plugin-instructions plugin="${plugin.replace(/[^\w.:-]/g, "")}">\n${body}\n</plugin-instructions>`;
  });
  return sections.length ? sections.join("\n\n") : undefined;
}
