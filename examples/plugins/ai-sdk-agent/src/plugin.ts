import type { ChangeEvent, ReactNode } from "react";
import type { AgentConfigProps, Context } from "@buzz/author";
import {
	defaults,
	parseConfig,
	PROVIDERS,
	validate,
	type Config,
	type Provider,
} from "./config.ts";
import { hostFetch } from "./host-fetch.ts";
import { run, RUN_TIMEOUT_MS } from "./run.ts";

export const inject = ["react", "relay", "host", "agentTypes"];

export function apply(ctx: Context) {
	const h = ctx.react.createElement;

	// The host's form classes, so the fields match the Name field above them.
	function Configure({
		config,
		disabled,
		onChange,
	}: AgentConfigProps<unknown>) {
		const value = parseConfig(config);
		const set = (patch: Partial<Config>) => onChange({ ...value, ...patch });
		const field = (label: string, control: ReactNode, description?: string) =>
			h(
				"label",
				{ className: "buzz-field" },
				h("span", { className: "buzz-field-label" }, label),
				control,
				description &&
					h("span", { className: "buzz-field-description" }, description),
			);
		const text =
			(name: "apiKey" | "model") => (event: ChangeEvent<HTMLInputElement>) =>
				set({ [name]: event.target.value });
		return h(
			ctx.react.Fragment,
			null,
			field(
				"Provider",
				h(
					"select",
					{
						className: "buzz-input",
						disabled,
						value: value.provider,
						onChange: (event: ChangeEvent<HTMLSelectElement>) =>
							set({ provider: event.target.value as Provider }),
					},
					Object.entries(PROVIDERS).map(([id, provider]) =>
						h("option", { key: id, value: id }, provider.title),
					),
				),
			),
			field(
				"API key",
				h("input", {
					className: "buzz-input",
					type: "password",
					autoComplete: "off",
					disabled,
					value: value.apiKey,
					onChange: text("apiKey"),
				}),
				"Saved with this agent's settings on this device, unencrypted.",
			),
			field(
				"Model",
				h("input", {
					className: "buzz-input",
					disabled,
					value: value.model,
					placeholder: PROVIDERS[value.provider].model,
					onChange: text("model"),
				}),
			),
			field(
				"Instructions",
				h("textarea", {
					className: "buzz-textarea",
					disabled,
					value: value.instructions,
					onChange: (event: ChangeEvent<HTMLTextAreaElement>) =>
						set({ instructions: event.target.value }),
				}),
			),
		);
	}

	const fetch = hostFetch(() => ctx.host);
	ctx.agentTypes.register<unknown>({
		id: "assistant",
		title: "AI SDK assistant",
		description:
			"Answers when mentioned, using your Anthropic or OpenAI API key. It can read the channel it is mentioned in and post there.",
		defaults,
		Configure,
		validate,
		subscription: (_config, agent) => ({ kinds: [9], "#p": [agent.pubkey] }),
		timeoutMs: RUN_TIMEOUT_MS,
		run: (delivery) =>
			run(delivery, {
				fetch,
				// The session is replaced on reconnect, so take the current one per call.
				read: (filters, signal) =>
					ctx.relay.snapshot().session.read(filters, { signal }),
				names: async (pubkeys) => {
					const profiles = ctx.relay.snapshot().session.profiles;
					await profiles.ensure(pubkeys);
					const known = profiles.snapshot();
					return new Map(
						pubkeys.flatMap((pubkey) => {
							const name = known.get(pubkey)?.name;
							return name ? [[pubkey, name] as const] : [];
						}),
					);
				},
			}),
	});
}
