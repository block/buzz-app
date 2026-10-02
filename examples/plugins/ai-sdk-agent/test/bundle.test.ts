// The built artifact, loaded the way the app loads it: one module, capabilities from ctx.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const id = (letter: string) => letter.repeat(64);

test("the bundle registers one agent type whose form and subscription work", async () => {
	// @ts-ignore built by `npm run build`; it has no declarations.
	const plugin = await import("../dist/plugin.js");
	assert.deepEqual(plugin.inject, ["react", "relay", "host", "agentTypes"]);
	const types: any[] = [];
	plugin.apply({
		react: React,
		host: {},
		relay: {},
		agentTypes: { register: (type: unknown) => types.push(type) },
	});
	assert.equal(types.length, 1);
	const [type] = types;
	// What AgentTypesService.register requires.
	assert.match(type.id, /^[a-z0-9][a-z0-9._-]*$/);
	assert.ok(type.title);
	assert.equal(typeof type.run, "function");
	assert.ok(
		type.timeoutMs > 30_000,
		"a streamed answer outlives the default deadline",
	);
	assert.deepEqual(
		type.subscription(type.defaults, { pubkey: id("f"), owner: id("1") }),
		{
			kinds: [9],
			"#p": [id("f")],
		},
	);
	assert.match(type.validate(type.defaults), /API key/);
	assert.equal(type.validate({ ...type.defaults, apiKey: "k" }), undefined);

	const changes: any[] = [];
	const form = renderToStaticMarkup(
		React.createElement(type.Configure, {
			config: { ...type.defaults, provider: "openai", apiKey: "sk-secret" },
			disabled: false,
			onChange: (config: unknown) => changes.push(config),
		}),
	);
	for (const label of ["Provider", "API key", "Model", "Instructions"])
		assert.ok(form.includes(label), label);
	assert.match(form, /type="password"[^>]*value="sk-secret"/);
	assert.match(form, /placeholder="gpt-5-mini"/);
	assert.match(form, /<option value="openai" selected="">OpenAI<\/option>/);
});
