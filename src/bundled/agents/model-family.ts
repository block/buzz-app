/** Families for a multi-vendor API catalog, using both its display label and ID. */
export function modelFamily(model: { id: string; name: string }): string {
  const name = `${model.name} ${model.id}`.toLowerCase();
  if (/claude|anthropic/.test(name)) return "Claude";
  if (/gemini|gemma/.test(name)) return "Gemini";
  if (/(?:^|[\s/._-])(?:gpt|o[134](?:[\s/._-]|$))|openai/.test(name))
    return "OpenAI";
  if (/llama/.test(name)) return "LLaMA";
  if (/deepseek/.test(name)) return "DeepSeek";
  if (/qwen/.test(name)) return "Qwen";
  if (/kimi|moonshot/.test(name)) return "Kimi";
  if (/mistral|mixtral/.test(name)) return "Mistral";
  if (/grok/.test(name)) return "Grok";
  return "Other models";
}
