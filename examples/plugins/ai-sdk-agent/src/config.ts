export const PROVIDERS = {
  anthropic: { title: "Anthropic", model: "claude-sonnet-4-5" },
  openai: { title: "OpenAI", model: "gpt-5-mini" },
} as const;
export type Provider = keyof typeof PROVIDERS;
/** Saved on the agent record as JSON. `model` empty means the provider's default.
 * The API key is not here: it is a secret the host keeps. */
export type Config = {
  provider: Provider;
  model: string;
  instructions: string;
};
/** The name of the secret that holds the provider's API key. */
export const API_KEY = "API_KEY";
export const defaults: Config = {
  provider: "anthropic",
  model: "",
  instructions: "You are a helpful teammate. Answer briefly and directly.",
};

/** Saved config is untyped JSON an older version of this plugin may have written.
 * Text is kept as typed, so the form can show it; trim it where it is used. */
export function parseConfig(value: unknown): Config {
  const saved = (value && typeof value === "object" ? value : {}) as Partial<
    Record<keyof Config, unknown>
  >;
  const text = (field: "model" | "instructions") =>
    typeof saved[field] === "string" ? saved[field] : defaults[field];
  return {
    provider: saved.provider === "openai" ? "openai" : "anthropic",
    model: text("model"),
    instructions: text("instructions"),
  };
}
