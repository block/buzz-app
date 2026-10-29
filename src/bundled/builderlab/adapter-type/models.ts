import type { ModelChoice } from "../../../features/agents/ModelPicker";
import type { RemoteAgentModel } from "../agents/client";

// Builderlab owns these catalog aliases. Keep this mapping in sync with its
// catalog information until the API supplies a model-family field. Unknown
// names stay selectable under Other; labels, IDs and efforts remain server-owned.
const families = new Map([
  ["sol", "OpenAI"],
  ["luna", "OpenAI"],
  ["astra", "OpenAI"],
  ["sonnet", "Claude"],
  ["opus", "Claude"],
  ["grok", "Grok"],
  ["glm", "GLM"],
  ["kimi", "Kimi"],
  ["deepseek", "DeepSeek"],
]);

export function modelChoice(model: RemoteAgentModel): ModelChoice {
  const alias = model.displayName
    .trim()
    .toLowerCase()
    .split(/[\s._-]/)[0];
  return {
    id: model.id,
    label: model.displayName,
    family: families.get(alias ?? "") ?? "Other",
  };
}
