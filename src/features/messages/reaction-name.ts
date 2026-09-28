import data from "@emoji-mart/data/sets/15/native.json" with { type: "json" };

const names = new Map<string, string>();
for (const [name, entry] of Object.entries(data.emojis))
  for (const skin of entry.skins ?? [])
    if (skin.native && !names.has(skin.native))
      names.set(skin.native, `:${name}:`);

export function reactionName(content: string) {
  return names.get(content) ?? content;
}
