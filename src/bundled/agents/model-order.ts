import { modelFamily } from "./model-family";

type Model = { id: string; name: string };

/** Compare generations, not parameter counts or dated endpoint suffixes. */
function version(model: Model): number[] {
  for (const label of [model.name, model.id]) {
    const match = label
      .toLowerCase()
      .match(
        /(?:claude(?:[\s._-]+(?:opus|sonnet|haiku))?|gpt|gemini|gemma|grok|llama|qwen|deepseek[\s._-]*v?|kimi[\s._-]*k?)[\s._-]*(\d{1,2})(?:[._-](\d{1,2})(?!\d|b\b))?/,
      );
    if (match) return [Number(match[1]), Number(match[2] ?? 0)];
  }
  return [];
}

/** Keep family slots and equal/unknown versions stable in catalog order. */
export function newestModelsFirst<T extends Model>(models: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const model of models) {
    const family = modelFamily(model);
    const group = groups.get(family) ?? [];
    group.push(model);
    groups.set(family, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => {
      const av = version(a);
      const bv = version(b);
      return (bv[0] ?? -1) - (av[0] ?? -1) || (bv[1] ?? -1) - (av[1] ?? -1);
    });
  }
  return models.map(
    (model) => groups.get(modelFamily(model))?.shift() ?? model,
  );
}
