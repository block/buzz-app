import { parse as yamlParse } from "yaml";

/** NIP-11 `workflow_agent_mentions`: `owner` lets only runs the owner or a
 * timer started, with only message and delay steps, direct agents. */
export type WorkflowAgentMentions = "any" | "owner";

/** A missing or unknown value is an older relay's: every run may. */
export function workflowAgentMentions(
  info: Record<string, unknown>,
): WorkflowAgentMentions {
  return info.workflow_agent_mentions === "owner" ? "owner" : "any";
}

export const OWNER_RUNS_WARNING =
  "Agents you mention act only on runs you start (this relay uses owner-only agent mentions).";
export const NEVER_WARNING =
  "Agents you mention won't act on this workflow's messages.";

const PERSON_TRIGGERS = new Set([
  "message_posted",
  "reaction_added",
  "diff_posted",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** What owner-only agent mentions means for this definition's agent
 * mentions, as the relay decides it: by trigger and every step's action. */
export function getAgentMentionWarning(
  yaml: string,
  agentNames: readonly string[],
  mode: WorkflowAgentMentions,
): string | null {
  if (mode !== "owner" || !agentNames.length) return null;
  let definition: Record<string, unknown> | undefined;
  try {
    definition = record(yamlParse(yaml));
  } catch {
    return null;
  }
  const steps = Array.isArray(definition?.steps)
    ? definition.steps.map(record)
    : [];
  const mentions = steps.some((step) => {
    const text = step?.action === "send_message" ? step.text : undefined;
    return (
      typeof text === "string" &&
      agentNames.some((name) => text.includes(`@${name}`))
    );
  });
  if (!mentions) return null;
  const trigger = record(definition?.trigger)?.on;
  if (
    trigger === "webhook" ||
    steps.some(
      (step) => step?.action !== "send_message" && step?.action !== "delay",
    )
  )
    return NEVER_WARNING;
  return typeof trigger === "string" && PERSON_TRIGGERS.has(trigger)
    ? OWNER_RUNS_WARNING
    : null;
}
