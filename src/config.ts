export const PROVIDERS = {
	anthropic: { title: "Anthropic", model: "claude-sonnet-4-5" },
	openai: { title: "OpenAI", model: "gpt-5-mini" },
} as const;
export type Provider = keyof typeof PROVIDERS;
/** Saved on the agent record as JSON. `model` empty means the provider's default. */
export type Config = {
	provider: Provider;
	apiKey: string;
	model: string;
	instructions: string;
};
export const defaults: Config = {
	provider: "anthropic",
	apiKey: "",
	model: "",
	instructions: "You are a helpful teammate. Answer briefly and directly.",
};

/** Saved config is untyped JSON an older version of this plugin may have written.
 * Text is kept as typed, so the form can show it; trim it where it is used. */
export function parseConfig(value: unknown): Config {
	const saved = (value && typeof value === "object" ? value : {}) as Partial<
		Record<keyof Config, unknown>
	>;
	const text = (field: keyof Config) =>
		typeof saved[field] === "string"
			? (saved[field] as string)
			: defaults[field];
	return {
		provider: saved.provider === "openai" ? "openai" : "anthropic",
		apiKey: text("apiKey"),
		model: text("model"),
		instructions: text("instructions"),
	};
}

export function validate(value: unknown): string | undefined {
	const config = parseConfig(value);
	if (!config.apiKey.trim())
		return `Enter an ${PROVIDERS[config.provider].title} API key.`;
	return undefined;
}
