import { parse as parseYaml } from "yaml";

export type WorkflowCardIcon =
  | "delay"
  | "diff"
  | "message"
  | "reaction"
  | "schedule"
  | "webhook"
  | "workflow";

export type WorkflowCardPresentation = Readonly<{
  actionIcons: readonly Readonly<{
    icon: WorkflowCardIcon;
    key: string;
  }>[];
  description: string;
  triggerEmoji: string | null;
  triggerIcon: WorkflowCardIcon;
}>;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function triggerPresentation(trigger: UnknownRecord | null): {
  icon: WorkflowCardIcon;
  label: string;
  emoji: string | null;
} {
  const type = typeof trigger?.on === "string" ? trigger.on : "";
  switch (type) {
    case "message_posted":
      return {
        icon: "message",
        label: "When a message is posted",
        emoji: null,
      };
    case "reaction_added":
      return {
        icon: "reaction",
        label: "When a reaction is added",
        emoji: typeof trigger?.emoji === "string" ? trigger.emoji : null,
      };
    case "diff_posted":
      return { icon: "diff", label: "When a diff is posted", emoji: null };
    case "schedule":
      return { icon: "schedule", label: "On a schedule", emoji: null };
    case "webhook":
      return {
        icon: "webhook",
        label: "When a webhook is received",
        emoji: null,
      };
    default:
      return {
        icon: "workflow",
        label: "When its trigger matches",
        emoji: null,
      };
  }
}

function actionPresentation(action: unknown): {
  icon: WorkflowCardIcon;
  label: string;
} {
  switch (action) {
    case "send_message":
    case "send_dm":
      return { icon: "message", label: "send a message" };
    case "delay":
      return { icon: "delay", label: "wait" };
    case "add_reaction":
      return { icon: "reaction", label: "add a reaction" };
    case "call_webhook":
      return { icon: "webhook", label: "call a webhook" };
    default:
      return { icon: "workflow", label: "run an action" };
  }
}

function joinActions(labels: readonly string[]): string {
  const first = labels[0];
  const second = labels[1];
  if (!first) return "run no actions";
  if (!second) return first;
  if (labels.length === 2) return `${first} and ${second}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1) ?? second}`;
}

export function workflowCardPresentation(
  yaml: string,
): WorkflowCardPresentation {
  try {
    const document = record(parseYaml(yaml));
    const trigger = triggerPresentation(record(document?.trigger));
    const actions = Array.isArray(document?.steps)
      ? document.steps.map((step, index) => {
          const fields = record(step);
          return {
            ...actionPresentation(fields?.action),
            key:
              typeof fields?.id === "string"
                ? fields.id
                : `unidentified-${index}`,
          };
        })
      : [];
    return {
      actionIcons: actions.map((action) => ({
        icon: action.icon,
        key: action.key,
      })),
      description: `${trigger.label}, ${joinActions(actions.map((action) => action.label))}.`,
      triggerEmoji: trigger.emoji,
      triggerIcon: trigger.icon,
    };
  } catch {
    return {
      actionIcons: [],
      description: "Review this workflow configuration.",
      triggerEmoji: null,
      triggerIcon: "workflow",
    };
  }
}
