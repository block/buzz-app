import { parseDocument, isMap } from "yaml";
import type {
  WorkflowDefinition,
  WorkflowOperation,
} from "../../features/workflows/types";
import { yamlToFormState, type WorkflowFormState } from "./workflowFormTypes";

export const EDITOR_TRIGGERS = ["message_posted", "reaction_added"] as const;
export const EDITOR_ACTIONS = ["send_message", "delay"] as const;

/** A smaller visual menu must not silently take ownership of advanced YAML. */
export function visualForm(yaml: string): ReturnType<typeof yamlToFormState> {
  const parsed = yamlToFormState(yaml);
  if (!parsed.ok) return parsed;
  if (
    !EDITOR_TRIGGERS.some((on) => on === parsed.state.trigger.on) ||
    parsed.state.steps.some(
      (step) => !EDITOR_ACTIONS.some((action) => action === step.action),
    )
  ) {
    return {
      ok: false,
      error:
        "This definition uses advanced triggers or actions. Keep editing its original YAML.",
    };
  }
  return parsed;
}

/** Draft shape validation is not relay authorization or a promise of execution. */
export function draftError(yaml: string): string | null {
  if (new TextEncoder().encode(yaml).length > 64 * 1024)
    return "The draft is too large (64 KiB maximum).";
  try {
    const doc = parseDocument(yaml);
    if (doc.errors.length)
      return "The YAML cannot be parsed. Correct it before saving.";
    if (!isMap(doc.contents)) return "The definition must be a YAML object.";
    const data = doc.toJS() as Record<string, unknown>;
    if (typeof data.name !== "string" || !data.name.trim())
      return "Give this workflow a name.";
    if (data.enabled !== undefined && typeof data.enabled !== "boolean")
      return "enabled must be true or false.";
    if (
      !data.trigger ||
      typeof data.trigger !== "object" ||
      Array.isArray(data.trigger) ||
      typeof (data.trigger as Record<string, unknown>).on !== "string"
    )
      return "Choose a trigger.";
    if (!Array.isArray(data.steps) || !data.steps.length)
      return "Add at least one step.";
    const ids = new Set<string>();
    for (const step of data.steps) {
      if (
        !step ||
        typeof step !== "object" ||
        typeof step.id !== "string" ||
        !/^[A-Za-z0-9_]{1,64}$/.test(step.id) ||
        ids.has(step.id)
      )
        return "Step IDs must be unique, with 1–64 letters, digits or underscores.";
      ids.add(step.id);
      if (typeof step.action !== "string") return "Each step needs an action.";
      if (
        step.action === "send_message" &&
        (typeof step.text !== "string" || !step.text.trim())
      )
        return "Each Send Message step needs message text.";
      if (
        step.action === "delay" &&
        (typeof step.duration !== "string" || !step.duration.trim())
      )
        return "Each Delay step needs a duration.";
    }
    return null;
  } catch {
    return "The YAML cannot be parsed. Correct it before saving.";
  }
}

/** No secret display exists in this slice: do not offer webhook-trigger writes. */
export function hasWebhookTrigger(yaml: string): boolean {
  try {
    const data = parseDocument(yaml).toJS();
    return data?.trigger?.on === "webhook";
  } catch {
    return false;
  }
}

export function formWithStep(
  state: WorkflowFormState,
  id: string,
  patch: Partial<WorkflowFormState["steps"][number]>,
): WorkflowFormState {
  return {
    ...state,
    steps: state.steps.map((step) =>
      step.id === id ? { ...step, ...patch } : step,
    ),
  };
}

/** Never adopt another editor's head as readback for our successful save. */
export function exactSaveReadback(
  operation: WorkflowOperation,
  definitions: readonly WorkflowDefinition[],
): WorkflowDefinition | undefined {
  if (operation.action !== "save" || operation.outcome !== "succeeded")
    return undefined;
  return definitions.find(
    (definition) =>
      definition.revision === operation.eventId &&
      definition.id === operation.workflow.id &&
      definition.owner === operation.workflow.owner &&
      definition.channelId === operation.workflow.channelId,
  );
}
