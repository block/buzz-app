import { parseDocument } from "yaml";
import { isUnicodeEmojiOnly } from "../../features/messages/emoji-size";
import { isReactionShortcode } from "../../features/relay/emoji";
import { record, workflowYaml } from "../../features/workflows/protocol";
import type { WorkflowDefinition } from "../../features/workflows/types";
import { parseConditionExpression } from "../workflows/workflowConditionExpression";

export type WorkflowReaction = Readonly<{
  emoji: string;
  labels: readonly string[];
}>;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function reaction(value: unknown): string | undefined {
  if (typeof value !== "string" || value !== value.trim()) return;
  return isReactionShortcode(value) ||
    (isUnicodeEmojiOnly(value) && [...graphemes.segment(value)].length === 1)
    ? value
    : undefined;
}
function equality(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const parsed = parseConditionExpression(value, "reaction_added");
  return parsed?.field === "trigger_emoji" && parsed.operator === "equals"
    ? reaction(parsed.value)
    : undefined;
}
const unconditional = (value: unknown) =>
  value === undefined || value === "true";

/** Configuration discovery only. Never evaluate expressions or predict a run.
 * Unknown predicates are omitted rather than guessed. Preserve literal emoji,
 * including skin tones, and group all known actions behind one reaction. */
export function workflowReactions(
  definitions: readonly WorkflowDefinition[],
  channelId: string,
) {
  const grouped = new Map<string, Set<string>>();
  let incomplete = false;
  const add = (emoji: string, label: string) => {
    const labels = grouped.get(emoji) ?? new Set<string>();
    labels.add(label);
    grouped.set(emoji, labels);
  };
  for (const definition of definitions) {
    if (definition.channelId !== channelId) continue;
    try {
      const summary = workflowYaml(definition.yaml);
      if (!summary.enabled) continue;
      // workflowYaml has already bounded bytes, aliases and structural shape.
      const config: unknown = parseDocument(definition.yaml).toJS({
        maxAliasCount: 50,
      });
      if (
        !record(config) ||
        !record(config.trigger) ||
        !Array.isArray(config.steps)
      )
        continue;
      const trigger = config.trigger;
      if (trigger.on !== "reaction_added" || trigger.filter === "false")
        continue;
      const declared = reaction(trigger.emoji);
      const filtered = equality(trigger.filter);
      if (!unconditional(trigger.filter) && !filtered) {
        incomplete = true;
        continue;
      }
      if (declared && filtered && declared !== filtered) continue;
      if (trigger.emoji !== undefined && !declared) {
        incomplete = true;
        continue;
      }
      const fixed = declared ?? filtered;
      let found = false;
      for (const step of config.steps) {
        if (!record(step) || step.if === "false") continue;
        const branch = equality(step.if);
        if (!unconditional(step.if) && !branch) {
          incomplete = true;
          continue;
        }
        if (fixed && branch && fixed !== branch) continue;
        const emoji = fixed ?? branch;
        if (!emoji) {
          incomplete = true;
          continue;
        }
        const name =
          typeof step.name === "string" && step.name.trim()
            ? step.name.trim()
            : String(step.id).replaceAll("_", " ");
        add(emoji, branch ? `${summary.name} — ${name}` : summary.name);
        found = true;
      }
      if (
        fixed &&
        !found &&
        config.steps.some((step) => record(step) && step.if !== "false")
      ) {
        // The declared trigger is discoverable even if its steps are conditional.
        add(fixed, summary.name);
      }
    } catch {
      // A malformed or newer definition must not take away the ordinary picker.
      incomplete = true;
    }
  }
  return {
    items: [...grouped].map(([emoji, labels]) => ({
      emoji,
      labels: [...labels],
    })),
    incomplete,
  };
}
